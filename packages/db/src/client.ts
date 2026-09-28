import { PGlite } from '@electric-sql/pglite';
import { entityTableDdl, type EntityRow, type EntityType } from './schema.js';

/**
 * Dev/local database: PGlite (embedded Postgres WASM), in-memory mode.
 * Production swaps to Supabase Postgres (Mumbai) via ./server.ts
 * with the same interface, so app code never knows the difference.
 */

// Cache on globalThis: Next.js bundles each API route separately, and a plain
// module-level singleton would give every route its own empty database.
const g = globalThis as unknown as { __factoryDb?: PGlite; __factoryDbReady?: Promise<PGlite> };

let instance: PGlite | null = null;
let ready: Promise<PGlite> | null = null;

/**
 * Web/dev database: in-memory PGlite, seeded on first access (session.ts).
 * For a persistent dev store swap to a nodefs dataDir; for production use the
 * Supabase path in ./server.ts. (pgvector is not loadable inside PGlite 0.2.x;
 * embeddings run JSONB + TS cosine — see schema.ts PGVECTOR_MIGRATION_SQL.)
 */
export function getDb(): PGlite {
  if (!g.__factoryDb) {
    instance = new PGlite(undefined, {});
    g.__factoryDb = instance;
  }
  return g.__factoryDb;
}

/** For Node (CLI seeding, evals) use an in-memory PGlite. */
export function getMemoryDb(): PGlite {
  return getDb();
}

export async function initDb(db?: PGlite): Promise<PGlite> {
  const d = db ?? getDb();
  if (!g.__factoryDbReady) {
    ready = (async () => {
      await d.exec(entityTableDdl());
      return d;
    })();
    g.__factoryDbReady = ready;
  }
  await g.__factoryDbReady;
  return d;
}

/** Set tenant context for RLS-enabled sessions (Supabase prod path). */
export async function setOrgContext(db: PGlite, orgId: string): Promise<void> {
  await db.exec(`select set_config('app.org_id', '${orgId.replace(/'/g, "''")}', false);`);
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  db?: PGlite
): Promise<T[]> {
  const d = db ?? (await initDb());
  const res = await d.query(sql, params as never[]);
  return res.rows as T[];
}

export async function exec(sql: string, db?: PGlite): Promise<void> {
  const d = db ?? (await initDb());
  await d.exec(sql);
}

// ---------------------------------------------------------------------------
// Entity helpers (unified table)
// ---------------------------------------------------------------------------

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export async function insertEntity(row: Partial<EntityRow> & { type: EntityType; orgId: string }, db?: PGlite): Promise<EntityRow> {
  const full: EntityRow = {
    id: row.id ?? newId(row.type.slice(0, 4)),
    orgId: row.orgId,
    type: row.type,
    code: row.code,
    name: row.name,
    status: row.status,
    amount: row.amount,
    qty: row.qty,
    rate: row.rate,
    date: row.date,
    partyId: row.partyId,
    itemId: row.itemId,
    warehouseId: row.warehouseId,
    tags: row.tags ?? [],
    source: row.source ?? 'seed',
    sourceId: row.sourceId,
    data: row.data ?? {},
  };
  await query(
    `insert into entities (id, org_id, type, code, name, status, amount, qty, rate, date, party_id, item_id, warehouse_id, tags, source, source_id, data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      full.id, full.orgId, full.type, full.code ?? null, full.name ?? null, full.status ?? null,
      full.amount ?? null, full.qty ?? null, full.rate ?? null, full.date ?? null,
      full.partyId ?? null, full.itemId ?? null, full.warehouseId ?? null,
      full.tags ?? [], full.source ?? 'seed', full.sourceId ?? null, JSON.stringify(full.data ?? {}),
    ],
    db
  );
  return full;
}

export async function listEntities(
  orgId: string,
  filter: { type?: string; ids?: string[]; limit?: number } = {},
  db?: PGlite
): Promise<EntityRow[]> {
  const params: unknown[] = [orgId];
  let where = 'org_id = $1';
  if (filter.type) {
    params.push(filter.type);
    where += ` and type = $${params.length}`;
  }
  if (filter.ids?.length) {
    params.push(filter.ids);
    where += ` and id = any($${params.length})`;
  }
  params.push(filter.limit ?? 500);
  return query<EntityRow>(
    `select data from entities where ${where} order by created_at desc limit $${params.length}`,
    params,
    db
  );
}

export async function getEntity(orgId: string, id: string, db?: PGlite): Promise<EntityRow | null> {
  const rows = await query<EntityRow>('select data from entities where org_id = $1 and id = $2', [orgId, id], db);
  return rows[0] ?? null;
}

export async function upsertEntityBySource(
  orgId: string,
  source: string,
  sourceId: string,
  row: Partial<EntityRow> & { type: EntityType },
  db?: PGlite
): Promise<EntityRow> {
  const existing = await query<EntityRow>(
    'select data from entities where org_id = $1 and source = $2 and source_id = $3 limit 1',
    [orgId, source, sourceId],
    db
  );
  if (existing[0]) {
    const merged = { ...existing[0], ...row, id: existing[0].id, orgId, source, sourceId };
    await query(
      `update entities set code=$3,name=$4,status=$5,amount=$6,qty=$7,rate=$8,date=$9,party_id=$10,item_id=$11,warehouse_id=$12,tags=$13,data=$14,updated_at=now()
       where org_id=$1 and source=$2 and source_id=$15`,
      [orgId, source, merged.code ?? null, merged.name ?? null, merged.status ?? null, merged.amount ?? null,
       merged.qty ?? null, merged.rate ?? null, merged.date ?? null, merged.partyId ?? null, merged.itemId ?? null,
       merged.warehouseId ?? null, merged.tags ?? [], JSON.stringify(merged.data ?? {}), sourceId],
      db
    );
    return merged;
  }
  return insertEntity({ ...row, orgId, source, sourceId }, db);
}

export async function audit(
  orgId: string,
  actor: string,
  action: string,
  opts: { entityType?: string; entityId?: string; before?: unknown; after?: unknown; metadata?: Record<string, unknown> } = {},
  db?: PGlite
): Promise<void> {
  await query(
    `insert into audit_log (org_id, actor, action, entity_type, entity_id, before, after, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orgId, actor, action, opts.entityType ?? null, opts.entityId ?? null,
     opts.before ? JSON.stringify(opts.before) : null, opts.after ? JSON.stringify(opts.after) : null,
     JSON.stringify(opts.metadata ?? {})],
    db
  );
}

export async function traceRun(
  run: {
    orgId: string;
    conversationId?: string;
    agent: string;
    model: string;
    input: unknown;
    output?: unknown;
    toolCalls?: unknown[];
    tokensIn?: number;
    tokensOut?: number;
    costInr?: number;
    latencyMs?: number;
    status?: string;
    error?: string;
  },
  db?: PGlite
): Promise<string> {
  const rows = await query<{ id: string }>(
    `insert into agent_runs (org_id, conversation_id, agent, model, input, output, tool_calls, tokens_in, tokens_out, cost_inr, latency_ms, status, error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [run.orgId, run.conversationId ?? null, run.agent, run.model, JSON.stringify(run.input),
     run.output ? JSON.stringify(run.output) : null, JSON.stringify(run.toolCalls ?? []),
     run.tokensIn ?? 0, run.tokensOut ?? 0, run.costInr ?? 0, run.latencyMs ?? null,
     run.status ?? 'done', run.error ?? null],
    db
  );
  return rows[0]!.id;
}

export async function meter(
  orgId: string,
  feature: string,
  tokens: number,
  costInr: number,
  db?: PGlite
): Promise<void> {
  await query(
    'insert into usage_metering (org_id, feature, tokens, cost_inr) values ($1,$2,$3,$4)',
    [orgId, feature, tokens, costInr],
    db
  );
}
