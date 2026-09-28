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
| F1 | Workspace / org context (multi-org, demo seed) | `apps/web/src/lib/session.ts`, `/settings` |
| F2 | Chat over factory data (EN/Hindi/Hinglish) with citations | `/` chat home, `packages/agents/src/orchestrator.ts` |
| F3 | Daily WhatsApp/email digest of the factory | `/digest`, `packages/agents/src/digest.ts`, `POST /api/jobs/daily` |
| F4 | Document intake: PO/invoice parsing → review queue → SO | `/documents`, `packages/agents/src/extraction.ts` |
| F5 | Procurement: reorder checks, RFQ drafts, PO drafts | `/procurement`, `packages/agents/src/tools/write.ts` |
| F6 | Collections: overdue buckets, reminder drafts | `/collections`, `list_overdue` tool |
| F7 | Approvals inbox: policy engine (auto/ask/deny) | `/approvals`, `packages/core/src/policy.ts` |
| F8 | Connectors: Tally (desktop), CSV, GSP, WhatsApp | `packages/connectors/`, `apps/connector-desktop/` |
| F9 | Voice (STT/TTS) & WhatsApp channel | `POST /api/webhooks/whatsapp`, channel: 'whatsapp' |
| F10 | Observability: traces, metering, audit log | `/audit`, `traceRun`/`meter`/`audit` in `packages/db` |
| — | Vertical packs (fabrication / FMCG / scrap / exports) | `packages/core/src/packs.ts` |
| — | Guardrails: role allowlists, PII redaction, prompt-injection isolation | `packages/core/src/guardrails.ts` |
| — | Semantic metric layer (numbers come from SQL, never the model) | `packages/agents/src/semantic.ts` |

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

## AI stack

- **Vercel AI SDK v5** (`ai@^5`): `streamText` tool-calling loop with `stepCountIs` guard,
  `generateObject` for extraction, `useChat` + `DefaultChatTransport` on the client.
- **AI Elements**: every chat-surface component is hand-built under
  `apps/web/src/components/ai-elements/` (barrel-exported) — no external UI kit for the
  conversation layer.
- **Models**: production routes through **OpenRouter** (`@openrouter/ai-sdk-provider`;
  model IDs are config, not code: `AI_PROFILE=prod`, `OPENROUTER_API_KEY`, `AI_MODEL_ROUTE=default|budget`).
  Dev/CI uses a **deterministic in-process mock model** (`packages/agents/src/mock-model.ts`)
  implementing the `LanguageModelV2` provider spec — it plans real tool calls over your data,
  so the whole agent loop runs offline with zero API keys.
- **Embeddings**: JSONB float arrays + TypeScript cosine similarity in dev (pgvector cannot
  load inside PGlite 0.2 wasm). For Supabase prod run `PGVECTOR_MIGRATION_SQL` from
  `packages/db/src/schema.ts` — `searchSimilar` switches to the `<=>` operator automatically.

## Quickstart

```bash
npm install
npm run dev          # apps/web on http://localhost:3100
npm test             # eval suite (7 golden cases) via tsx
npm run build        # production build of apps/web
```

First page load auto-seeds the demo org **Precision Metalworks Pvt Ltd** (fabrication pack)
with parties, items, orders, invoices, job cards and stock ledger. Switch orgs / approval
policies in **Settings**. No environment variables needed in dev.

### Environment (production)

| Var | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | LLM access (prod) |
| `AI_PROFILE` | `dev` (mock model) / `prod` (OpenRouter) |
| `AI_MODEL_ROUTE` | `default` (gpt-4o class) / `budget` (flash/sonnet class) |
| `DATABASE_URL` | Supabase Postgres for the prod path in `packages/db/src/server.ts` |

## Eval suite

`npm test -w packages/evals` runs golden cases against the real data layer:

- **extraction** ×3 — PO parsing completeness, missing-field flagging, amount normalisation
- **metric** ×2 — receivables sanity, overdue ageing-bucket arithmetic
- **guardrail** ×2 — prompt-injection flagging, benign PO non-flagging

## Design notes

- **Deterministic first**: business logic lives in tools/SQL; the LLM plans and explains.
  The system prompt forbids inventing figures; metrics come from the semantic layer.
- **Policy engine on every write**: agent actions (POs, reminders, RFQs, digests) route
  through `policy.ts` → `auto` executes, `ask` lands in the Approvals inbox, `deny` blocks —
  with a full audit trail.
- **Tenant safety**: every query takes `orgId`; role allowlists gate write tools;
  untrusted document text is isolated behind injection guardrails before reaching a model.
