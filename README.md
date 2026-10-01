# Factory AI OS

**The AI operations layer for the Indian MSME factory.** Factory AI OS sits on top of the tools
factories already run — Tally, Excel, WhatsApp — and turns scattered operational data into an
agent you can talk to: sales, stock, receivables, production, procurement and collections in
English, Hindi or Hinglish, with every number grounded in your data and every write action
governed by an approval policy.

Built with the **Vercel AI SDK (v5)** and hand-built **AI Elements** components throughout —
Conversation, Message, Response, PromptInput, Tool, Reasoning, Sources, Suggestion,
ChainOfThought, Actions/Confirmation, Artifact and BranchPicker (`apps/web/src/components/ai-elements/`).

---

## What it does (PRD feature map)

| PRD | Feature | Where |
| --- | --- | --- |
| F1 | Workspace / org context (multi-org, demo seed) + pilot onboarding checklist | `apps/web/src/lib/session.ts`, `/settings` |
| F2 | Chat over factory data (EN/Hindi/Hinglish) with citations | `/` chat home, `packages/agents/src/orchestrator.ts` |
| F3 | Daily WhatsApp/email digest of the factory | `/digest`, `packages/agents/src/digest.ts`, `POST /api/jobs/daily` |
| F4 | Document intake: PO/invoice parsing → review queue → SO | `/documents`, `packages/agents/src/extraction.ts` |
| F5 | Procurement: reorder checks, RFQ drafts, PO drafts | `/procurement`, `packages/agents/src/tools/write.ts` |
| F6 | Collections: overdue buckets, reminder drafts | `/collections`, `list_overdue` tool |
| F7 | Approvals inbox: policy engine (auto/ask/deny) | `/approvals`, `packages/core/src/policy.ts` |
| F8 | Connectors: Tally (XML-over-HTTP + desktop agent), Zoho Books (OAuth), WhatsApp, CSV, GSP — live test/sync/push | `packages/connectors/`, `apps/connector-desktop/` |
| F9 | Voice (Sarvam STT) & WhatsApp channel: questions, approvals (`approve APPR-xxxxxxxx`), voice notes | `POST /api/webhooks/whatsapp`, `packages/connectors/src/sarvam.ts` |
| F10 | Observability: traces, metering, audit log | `/audit`, `traceRun`/`meter`/`audit` in `packages/db` |
| — | Vertical packs (fabrication / FMCG / scrap / exports) | `packages/core/src/packs.ts` |
| — | Guardrails: role allowlists, PII redaction, prompt-injection isolation | `packages/core/src/guardrails.ts` |
| — | Semantic metric layer (numbers come from SQL, never the model) | `packages/agents/src/semantic.ts` |
| — | WhatsApp as the product: inbound questions answered by the agent, approvals decided from the phone, voice notes via Sarvam STT | `apps/web/src/app/api/webhooks/whatsapp`, `packages/agents/src/notify.ts` |
| — | Closed-loop remediation: anomaly → drafted fix (reminder / RFQ / credit note) → approval → execution → WhatsApp outcome | `packages/agents/src/remediation.ts` |
| — | Conversational BI: `ask_data` group/aggregate over entity tables, rendered as inline charts in chat | `packages/agents/src/tools/read.ts`, `apps/web/src/components/ai-elements/chart.tsx` |
| — | Weekly pilot feedback digest: usage, override trend, correction themes → operator (case-study raw material), delivered to WhatsApp/email | `packages/agents/src/pilot-digest.ts`, `/api/jobs/pilot-digest` |
| — | Operator pilot cockpit: every workspace's onboarding progress, override trend and latest digest side by side | `/pilot` |
| — | Learning memory: corrections become reviewable org facts, applied in answers *and enforced in drafts* (price-floor guard on POs/SOs) | `packages/agents/src/memory.ts`, `remember` tool, `priceRulesFromFacts` |
| — | Proactive anomaly agent: price variance, duplicate invoices (→ credit-note drafts), receivables spike; fixes reported to WhatsApp on decision | `packages/agents/src/anomalies.ts`, `packages/agents/src/remediation.ts` |
| — | Demand forecast + BOM MRP buy suggestions (4-week horizon) | `packages/agents/src/mrp.ts`, `/procurement`, `run_mrp` agent tool |
| — | CI: typecheck ×6 workspaces, eval suite, production build | `.github/workflows/ci.yml` |

## Monorepo layout

```
apps/
  web/                  Next.js 15 (App Router) — chat home, dashboard, approvals,
                        documents, procurement, collections, digest, connectors,
                        audit, settings; /api/* routes for everything
  connector-desktop/    Node tray/CLI connector that heartbeats, pulls vouchers
                        from Tally (XML via ODBC path) and pushes to the API
packages/
  db/                   Data layer: PGlite (embedded Postgres) in dev, Supabase
                        Postgres in prod; unified `entities` table + documents,
                        conversations, approvals, traces, embeddings
  core/                 Domain: vertical packs, policy engine, guardrails
  agents/               AI SDK v5 orchestrator + tools, semantic metrics,
                        extraction, digest, embeddings (JSONB + cosine in dev)
  connectors/           Tally / CSV / GSP / WhatsApp connector interfaces
  evals/                Golden-case eval suite (extraction, metrics, guardrails)
```

## Agent workflows (the 13-agent spec)

Every agent follows the shared pattern — deterministic tools first, LLM only to interpret, every write through the policy engine (`auto`/`ask`/`deny`), every action on the activity timeline, shadow mode ON by default.

| # | Agent | Module / surface | Status |
| --- | --- | --- | --- |
| 1 | Orchestrator / Data Chat | `packages/agents/src/orchestrator.ts` + read tools (`query_data`, `ask_data`, `searchSimilar` citations) | ✅ built · 120 golden questions pass |
| 2 | Document Intake | `extraction.ts` + `dedupe.ts` (file-hash + field-signature dedupe), review queue → SO | ✅ built · eval `document_dedupe` · golden-document benchmark 100% across 31 fields (≥95% auto-processing gate OPEN) |
| 3 | Activity / Trust Layer | `activity.ts`, `/activity`, `/api/activity/export` (CSV/PDF), undo + feedback | ✅ built · `npm run audit:writes` gate green |
| 4 | Collections | `collections.ts` — cooldown + promise-to-pay honoured, ONE batch approval (`draft_reminders_batch`), `recordPromiseToPay`, date detection from replies | ✅ built · eval `collections_flow` |
| 5 | Procurement | `draft_rfq`/`create_po_draft` + `procurement.ts` (`compare_vendor_quotes`: parse → rank → recommend → persist `vendor_quote`) | ✅ built · eval `quote_comparison` |
| 6 | Weighbridge / Scrap | `weighbridge.ts`, WhatsApp photo/text intake → shadow draft → approval → ledger | ✅ built · eval `weighbridge_flow` |
| 7 | Export Buyer Follow-up | `exports.ts` — LUT/IEC + packing-list watch, drafted buyer messages | ✅ built · digest-section + read-tool coverage |
| 8 | Production / Shift | `shift.ts` — voice note → deterministic extraction → clarification if missing → job-card write via policy | ✅ built · eval `shift_report` |
| 9 | Quality | `quality.ts` + `log_inspection`/`log_defect_ncr` — NCR/CAPA drafts with similar-defect retrieval and 30-day trend escalation | ✅ built · eval `quality_flow` |
| 10 | Compliance | `einvoice.ts`/`eway.ts` + `compliance.ts` — threshold rule in config, GSP errors → human queue after 3 attempts | ✅ built · evals `einvoicing`, `ewb_validation`, `compliance_threshold` |
| 11 | Demand Forecasting | `mrp.ts` + `forecast.ts` — suggestions flagged (insufficient history / seasonal), batched `update_reorder_points` approval; per-week `forecast_snapshots` scored against actuals (`scoreForecastAccuracy`) | ✅ built · eval `override_rate` covers the trust metric; forecast maths exercised via `runForecastCycle`; snapshot accuracy measured, not assumed |
| 12 | Customer Service | `customer-service.ts` — order status, complaint tickets, angry-tone human handoff (webhook resolves customer numbers) | ✅ built · eval `customer_service_flow` · self-registration verified live |
| 13 | Maintenance | `maintenance.ts` + `check_maintenance`/`draft_maintenance_wo` — calendar PM with explicit `basis:'calendar'`, missing intervals listed; **P2b telemetry path built**: edge gateway → `POST /api/ingest/machine` → `detectAnomaly` vs per-metric baselines (EWMA-tracked) → `telemetry_anomaly` activity + urgent WhatsApp alert | ✅ built · eval `maintenance_schedule` |

Scheduled agents (4, 10, 11, 13 + digests/remediation) run inside the nightly cron (`/api/jobs/daily`); the weekly pilot digest (Mondays) reports their outcomes per org. A5/A9/A11/A13 are also conversational tools the orchestrator can call.

## AI stack

- **Vercel AI SDK v5** (`ai@^5`): `streamText` tool-calling loop with `stepCountIs` guard,
  `generateObject` for extraction, `useChat` + `DefaultChatTransport` on the client.
- **AI Elements**: every chat-surface component is hand-built under
  `apps/web/src/components/ai-elements/` (barrel-exported) — no external UI kit for the
  conversation layer.
- **Models**: production routes through **OpenRouter** (`@openrouter/ai-sdk-provider`;
  model IDs are config, not code: `AI_PROFILE=prod`, `OPENROUTER_API_KEY`, `AI_MODEL_ROUTE=default|budget`).
  **The OpenRouter key is platform-side** — the operator sets it once; subscribers never paste
  keys, they only pick a model class in Settings (Smartest / Value). AI usage cost is metered
  per org (`usage_metering`, INR estimates) for subscription billing.
  Dev/CI uses a **deterministic in-process mock model** (`packages/agents/src/mock-model.ts`)
  implementing the `LanguageModelV2` provider spec — it plans real tool calls over your data,
  so the whole agent loop runs offline with zero API keys.
- **Embeddings + pgvector**: local PGlite stores `embeddings.vec` as JSONB with TypeScript
  cosine similarity (pgvector cannot load inside PGlite 0.2 wasm). On remote Postgres the
  client auto-applies `PGVECTOR_MIGRATION_SQL` (`packages/db/src/schema.ts`) once per process:
  the column becomes a real `vector(1536)` with an ivfflat cosine index and `searchSimilar`
  switches to the `<=>` operator (detected via `information_schema`, in-database ranking,
  graceful JSONB fallback if the extension is unavailable). Verified on Neon.
- **Storage engines** (`packages/db`): set `DATABASE_URL` (Neon / Supabase / any Postgres) and
  every query — entities, approvals, documents, traces — goes to remote Postgres (schema
  auto-applies); unset, it uses local PGlite persisted to `.pglite-data/` so dev data survives
  restarts (`FACTORY_DB_MEMORY=1` forces in-memory for evals/CI). Same code, zero call-site
  changes. See `.env.example`.
- **AI model config**: subscribers choose **Smartest / Value** in **Settings → AI model**;
  the choice is stored per org (`ai_config.model_route`) and applied immediately. The
  OpenRouter key itself is platform-side (`OPENROUTER_API_KEY` env on the operator's deploy);
  legacy per-org keys in `ai_config` still work but are deprecated.
- **Tally desktop connector**: register it on the **Connectors** page (device token shown
  once), run `apps/connector-desktop` on the Tally machine — it heartbeats every 30s, pulls
  masters, and pushes **approved** `tally_push` vouchers, acking results back into the audit log.
- **Daily cron & connector monitoring** (`vercel.json`): a Vercel Cron hits `GET /api/jobs/daily`
  daily at 02:30 UTC (guard with `CRON_SECRET` — `Authorization: Bearer …`). Each run computes
  the digest for every org, queues the WhatsApp send, and runs connector health monitoring
  (`connectorHealth` in `packages/core/src/monitoring.ts`): connectors in `error` state, active
  connectors with no heartbeat for `STALE_AFTER_MIN` (default 60) minutes, and approved
  `tally_push` backlog are audited (`monitor.connector_health`) and surfaced live on the
  dashboard's **Connector health** card. `POST /api/jobs/daily` does digest + monitoring
  (manual/cron entry); `GET` is a monitoring-only snapshot.

## Quickstart

```bash
npm install
npm run dev              # apps/web on http://localhost:3100
npm test                 # eval suite (21 golden flow cases) via tsx
npm run test:golden -w packages/evals   # Agent 1 golden-question gate (30 per vertical)
npm run test:documents -w packages/evals # Agent 2 golden-document benchmark (≥95% auto-processing gate)
npm run audit:writes -w packages/agents # trust-layer write-coverage audit (Agent 3 done-when)
npm run build            # production build of apps/web
npm run smoke -w apps/web # operator smoke test against the running server (BASE_URL to target a deploy)
```

First page load auto-seeds the demo org **Precision Metalworks Pvt Ltd** (fabrication pack)
with parties, items, orders, invoices, job cards and stock ledger. Approval policies live in
**Settings**. No environment variables needed in dev.

### Accounts & demo

- **Sign up** (`/signup`) creates a real workspace — named after the subscriber's company and
  seeded with sample data — plus an owner account. Passwords are scrypt-hashed; sessions are
  httpOnly cookies backed by a server-side `sessions` table (30-day expiry). Auth API routes:
  `apps/web/src/app/api/auth/` — `signup`, `signin`, `signout`, `me`.
- **No-signup demo** still works: without a session the app runs against the seeded demo
  organizations, switchable in **Settings → Workspaces (demo)**. That selector is shown only
  to anonymous visitors — signed-in users are pinned to their own workspace (`getSession`
  in `apps/web/src/lib/session.ts` prefers the session user's org over the demo cookie).
- The app sidebar shows the signed-in user (avatar chip + **Sign out**), or Sign in /
  Get started links for anonymous visitors.

### Environment (production)

| Var | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | LLM access (prod) — **platform-side**: set by the operator; subscribers only pick a model class |
| `AI_PROFILE` | `dev` (mock model) / `prod` (OpenRouter) |
| `AI_MODEL_ROUTE` | `default` (gpt-4o class) / `budget` (flash/sonnet class) |
| `DATABASE_URL` | Remote Postgres (Neon / Supabase) — pgvector migration auto-applies |
| `CRON_SECRET` | Bearer guard for the daily cron (`/api/jobs/daily`) |
| `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API outbound. Without them sends run in echo mode — recorded and audited but not delivered (dev default). Set the owner number under **Settings → WhatsApp delivery**. |
| `OPERATOR_WHATSAPP` / `OPERATOR_EMAIL` + `RESEND_API_KEY` | Platform-side only: where the **weekly pilot feedback digest** is delivered (WhatsApp needs the WhatsApp vars above; email via Resend). Without them the digest stays queued (`pilot_digest` template) and visible on `/pilot`. |

## Eval suite

`npm test -w packages/evals` runs golden cases against the real data layer:

- **extraction** ×3 — PO parsing completeness, missing-field flagging, amount normalisation
- **metric** ×2 — receivables sanity, overdue ageing-bucket arithmetic
- **guardrail** ×2 — prompt-injection flagging, benign PO non-flagging
- **shadow_mode** ×1 — auto actions become ask while shadow mode is on; execute live when off
- **einvoicing** ×1 — IRN generation via the GSP sandbox, persistence, idempotent re-generation
- **ewb_validation** ×1 — EWB rejects garbage vehicle/pincodes, requires IRN first, generates valid
- **override_rate** ×1 — week bucketing + override % arithmetic, trend classification (the PRD exit metric)
- **weighbridge_flow** ×1 — text parse → shadow draft → owner approval → purchase entry + inward scrap ledger
- **remediation_pipeline** ×1 — duplicate-invoice anomaly → credit-note draft (right fix) → approval → executed + audited
- **quote_comparison** ×1 — reply parsing, ranking with need-by filtering, recommendation, `vendor_quote` persistence
- **collections_flow** ×1 — reminder cooldown, promise-to-pay precedence, batched approval, date detection
- **shift_report** ×1 — transcript extraction, clarification on missing fields, policy-gated job-card write
- **compliance_threshold** ×1 — applicability rule (B2B + threshold in config) boundary behaviour
- **maintenance_schedule** ×1 — calendar PM due-window maths, missing intervals listed, WO drafted via policy

## PRD v2 wedge (trust-and-voice strategy)

Positioning per **PRD v2**: win on (1) a customer-facing trust/observability layer,
(2) Indic voice on WhatsApp, (3) the scrap/waste and exports verticals — not on
matching TranZact's full ERP surface.

- **F4 AI Activity (the trust layer)**: every agent action lands on `/activity` with a
  one-line human summary, the data sources it read, and why it acted. Executed actions
  are **undoable for 24h** (created records are cancelled, never deleted); 👍/👎 feedback
  feeds the eval set. Searchable; drafts awaiting approval appear on the timeline too.
  Exportable as **CSV or PDF** (`/api/activity/export`) so design partners can share the
  audit trail with their accountants — exports are audited, oldest-first, filters applied.
  Schema: `agent_actions` (summary, sources, reason, undone_at, feedback) — a product
  surface, not an ops table.
- **F8 Scrap/waste pack**: weighbridge ticket → WhatsApp photo (vision) or typed text
  ("gross 5420 tare 1220 grade MS solid from Ramesh") → seller match + grade rate from
  the rate card → purchase entry **drafted through the policy engine** → owner approves
  from web or WhatsApp → stock ledger updated; Tally sync follows. Missing rate or
  unknown seller are flagged in the reply, never guessed.
- **F9 Export pack**: LUT/IEC expiry + pending packing-list/commercial-invoice watch →
  buyer follow-up drafts queued via policy → digest section "🚢 Export documents".
- Data stays on **Neon Postgres** (pgvector auto-migration); Supabase is not used.

## Design notes

- **Deterministic first**: business logic lives in tools/SQL; the LLM plans and explains.
  The system prompt forbids inventing figures; metrics come from the semantic layer.
- **Policy engine on every write**: agent actions (POs, reminders, RFQs, digests) route
  through `policy.ts` → `auto` executes, `ask` lands in the Approvals inbox, `deny` blocks —
  with a full audit trail.
- **Tenant safety**: every query takes `orgId`; role allowlists gate write tools;
  untrusted document text is isolated behind injection guardrails before reaching a model.
