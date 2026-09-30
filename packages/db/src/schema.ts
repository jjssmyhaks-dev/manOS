/**
 * Factory AI OS — unified data model.
 *
 * Core design: one `entities` table holds domain records (parties, items,
 * orders, invoices, job cards, ...) as validated JSONB rows in a single
 * tenant-scoped table. This gives us:
 *  - every table carries org_id with RLS (PRD §8)
 *  - source-system IDs stored for idempotent two-way sync (Tally sourceId)
 *  - vertical packs add record types + fields as configuration, not forks
 *
 * Structured SQL answers run through the semantic layer (packages/agents)
 * against read-only views over this table. Full relational normalisation is
 * a scale-out step once pilots harden the field mappings.
 */

export const CORE_ENTITY_TYPES = [
  'party', // customer | vendor
  'item',
  'bom',
  'warehouse',
  'stock_ledger',
  'sales_order',
  'purchase_order',
  'invoice',
  'payment',
  'job_card',
  'work_order',
  'machine',
  'inspection',
  'ncr',
  'rfq',
  'vendor_quote',
  'grn',
  'weighbridge_ticket',
  'activity', // calls, reminders, follow-ups
] as const;

export type EntityType = (typeof CORE_ENTITY_TYPES)[number] | (string & {});

/** Risk level every agent tool must declare (PRD §17 conventions). */
export type ToolRisk = 'read' | 'write' | 'external';

/** Approval decision per action type per org/role (PRD harness layer). */
export type ApprovalDecision = 'auto' | 'ask' | 'deny';

export interface EntityRow {
  [key: string]: unknown;
  id: string;
  type: EntityType;
  orgId: string;
  code?: string;
  name?: string;
  status?: string;
  amount?: number;
  qty?: number;
  rate?: number;
  date?: string;
  partyId?: string;
  itemId?: string;
  warehouseId?: string;
  tags?: string[];
  source?: string;
  sourceId?: string;
  data?: Record<string, unknown>;
}

export const ENTITY_COLUMNS =
  'id text primary key, org_id uuid not null, type text not null, code text, name text, status text, ' +
  'amount numeric, qty numeric, rate numeric, date date, party_id text, item_id text, warehouse_id text, ' +
  'tags text[], source text, source_id text, data jsonb not null default (jsonb_build_object()), ' +
  'created_at timestamptz not null default now(), updated_at timestamptz not null default now()';

/** Column extraction for hot filters (SQL-inject safe: fixed identifiers). */

/**
 * Dev DDL (PGlite): embeddings.vec is JSONB and similarity is computed in TS
 * (packages/agents/embeddings.ts) — PGlite 0.2.x cannot load pgvector's .so.
 * On remote Postgres (Neon/Supabase) the client runs this migration once per
 * process (see ensureRemoteSchema): embeddings.vec becomes a real vector(1536)
 * column with an ivfflat cosine index and searchSimilar switches to the <=>
 * operator. Idempotent: safe to run on every boot; a no-op when the column is
 * already vector type or the extension is unavailable.
 */
export const PGVECTOR_MIGRATION_SQL = [
  'create extension if not exists vector;',
  'alter table embeddings alter column vec type vector(1536) using vec::text::vector;',
  'create index if not exists embeddings_vec_idx on embeddings using ivfflat (vec vector_cosine_ops) with (lists = 50);',
].join('\n');

export function entityTableDdl(): string {
  return `
-- gen_random_uuid() is native (PG13+); Supabase also exposes pgcrypto if needed
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  vertical text not null default 'fabrication',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  email text unique not null,
  name text,
  role text not null default 'owner', -- owner|manager|purchase|accounts|sales|operator|admin
  locale text not null default 'en',
  created_at timestamptz not null default now()
);

create table if not exists entities (
${ENTITY_COLUMNS}
);
create index if not exists entities_org_type_idx on entities (org_id, type);
create index if not exists entities_org_name_idx on entities (org_id, lower(name));
create index if not exists entities_party_idx on entities (org_id, party_id);
create index if not exists entities_item_idx on entities (org_id, item_id);
create index if not exists entities_date_idx on entities (org_id, date);
create index if not exists entities_data_gin on entities using gin (data jsonb_path_ops);

-- row level security: every org sees only its rows
alter table entities enable row level security;
drop policy if exists entities_org_isolation on entities;
create policy entities_org_isolation on entities
  using (org_id = current_setting('app.org_id', true)::uuid)
  with check (org_id = current_setting('app.org_id', true)::uuid);

create table if not exists embeddings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  entity_id text,
  kind text not null, -- doc|sop|chunk
  title text,
  content text not null,
  vec jsonb, -- dev: JSONB float array; prod: run PGVECTOR_MIGRATION_SQL for vector(1536)
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists embeddings_org_idx on embeddings (org_id);
alter table embeddings enable row level security;
drop policy if exists embeddings_org_isolation on embeddings;
create policy embeddings_org_isolation on embeddings
  using (org_id = current_setting('app.org_id', true)::uuid);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid,
  channel text not null default 'web', -- web|whatsapp
  title text,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  org_id uuid not null,
  role text not null, -- user|assistant|system|tool
  content text not null,
  parts jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- every agent run: prompt, tool calls, tokens, cost, outcome (observability)
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  conversation_id uuid,
  agent text not null,
  model text not null,
  input jsonb not null,
  output jsonb,
  tool_calls jsonb not null default '[]'::jsonb,
  tokens_in integer default 0,
  tokens_out integer default 0,
  cost_inr numeric default 0,
  latency_ms integer,
  status text not null default 'running', -- running|done|error
  error text,
  created_at timestamptz not null default now()
);

-- approvals inbox: every write/outbound passes the policy engine
create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  action_type text not null, -- send_reminder|create_po|send_rfq|tally_push|digest_send|...
  entity_type text,
  entity_id text,
  payload jsonb not null,
  preview text,
  risk text not null default 'write', -- write|external
  status text not null default 'pending', -- pending|approved|rejected|executed|failed
  requested_by text not null default 'agent',
  decided_by text,
  decided_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);

-- policy engine config: action_type -> auto|ask|deny per org
create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  action_type text not null,
  decision text not null default 'ask', -- auto|ask|deny
  updated_at timestamptz not null default now(),
  unique (org_id, action_type)
);

create table if not exists connectors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  type text not null, -- tally|csv|whatsapp|gmail|gsp|sarvam
  status text not null default 'disconnected', -- connected|error|disconnected|syncing
  config jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  device_token text,
  created_at timestamptz not null default now(),
  unique (org_id, type)
);

create table if not exists sync_state (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references connectors(id),
  entity_type text not null,
  last_alter_id bigint not null default 0,
  cursor jsonb,
  updated_at timestamptz not null default now(),
  unique (connector_id, entity_type)
);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor text not null, -- user id | 'agent' | 'system'
  action text not null,
  entity_type text,
  entity_id text,
  before jsonb,
  after jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_org_idx on audit_log (org_id, created_at desc);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  channel text not null, -- email|whatsapp|web
  to_addr text,
  template text,
  body text not null,
  status text not null default 'queued', -- queued|sent|failed|skipped
  approval_id uuid,
  error text,
  result jsonb, -- dispatcher outcome: attempts, messageId, echo, to (masked)
  created_at timestamptz not null default now()
);
-- older deployments created notifications without result; patch in place
alter table notifications add column if not exists result jsonb;

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind text not null, -- po|invoice|challan|quote|sop|other
  filename text,
  source text not null default 'upload', -- upload|email|whatsapp
  status text not null default 'extracting', -- extracting|review|ready|failed
  extraction jsonb,
  confidence numeric,
  entity_id text, -- linked sales_order etc after acceptance
  content text,
  created_at timestamptz not null default now()
);

create table if not exists usage_metering (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  feature text not null, -- chat|extraction|voice_stt|voice_tts|digest
  tokens integer default 0,
  cost_inr numeric default 0,
  day date not null default current_date,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists usage_org_day_idx on usage_metering (org_id, day);

-- per-org memory: reviewable facts the agent may use (PRD §6)
create table if not exists org_facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  fact text not null,
  source text not null default 'agent',
  status text not null default 'active', -- active|review|archived
  created_at timestamptz not null default now()
);

-- per-org AI model config (PRD §6): OpenRouter key + route, env fallback
create table if not exists ai_config (
  org_id uuid primary key,
  provider text not null default 'openrouter',
  api_key text,
  model_route text not null default 'default', -- default|budget
  updated_at timestamptz not null default now()
);

-- per-org outbound notification config (WhatsApp destination + auto-send)
create table if not exists notify_settings (
  org_id uuid primary key,
  owner_phone text, -- E.164 digits, e.g. 919812345678
  auto_send boolean not null default false, -- cron dispatches without a click
  updated_at timestamptz not null default now()
);
`.trim();
}
