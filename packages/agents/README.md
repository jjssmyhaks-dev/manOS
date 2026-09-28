# @factory/agents

AI runtime (Vercel AI SDK v5):

- `models.ts` — OpenRouter provider (prod) + deterministic mock (dev/CI), routed model IDs from config
- `semantic.ts` — named deterministic metrics; the LLM never writes numbers from memory
- `orchestrator.ts` — `streamText` multi-step tool loop; specialist capabilities as tools; traces + metering
- `tools/` — read tools over the semantic layer; write tools routed through the policy engine
- `extraction.ts` — document → strict Zod JSON with confidence, validation, review queue
- `digest.ts` — daily/weekly digests (numbers deterministic, narrative optional)
- `embeddings.ts` — pgvector retrieval (hash embeddings in dev)
- `memory.ts` — per-org reviewable facts
