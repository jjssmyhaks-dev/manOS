# @factory/db

Unified tenant-scoped data layer:

- `schema.ts` — entity model + DDL with RLS (`org_id` on every table)
- `client.ts` — PGlite (dev/in-memory) client, entity helpers, audit, agent-run trace, metering
- `server.ts` — Supabase Postgres path for production (same interface)
- `seed.ts` — synthetic seed generator (4 orgs: fabrication / FMCG / scrap / exports)
