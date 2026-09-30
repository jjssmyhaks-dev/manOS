import { query, hasRemoteDb } from '@factory/db';

/**
 * Unstructured retrieval (PRD §6): chunked documents embedded into pgvector
 * with tenant filter. Dev uses a deterministic hash embedding (no API needed);
 * prod swaps to OpenRouter/OpenAI embedding models via env config.
 */

export const EMBED_DIM = 1536;

/** Deterministic dev embedding — stable, no network. Not semantically strong. */
export function hashEmbed(text: string): number[] {
  const vec = new Array(EMBED_DIM).fill(0) as number[];
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % EMBED_DIM;
    vec[idx] = (vec[idx] ?? 0) + 1 / Math.sqrt(tokens.length || 1);
  }
  // normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export interface ChunkInput {
  orgId: string;
  kind: string;
  title: string;
  content: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export async function embedAndStore(input: ChunkInput): Promise<number> {
  const chunks = chunkText(input.content, 800);
  let stored = 0;
  for (const chunk of chunks) {
    const vec = embedVec(chunk);
    // vec is passed as a JSON float-array string, which is valid input for both
    // storage shapes: JSONB (local PGlite) and vector(1536) (remote Postgres,
    // where the server coerces the text literal via vec::text::vector rules).
    await query(
      `insert into embeddings (org_id, entity_id, kind, title, content, vec, metadata)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [input.orgId, input.entityId ?? null, input.kind, input.title, chunk, JSON.stringify(vec), JSON.stringify(input.metadata ?? {})]
    );
    stored++;
  }
  return stored;
}

function embedVec(text: string): number[] {
  return hashEmbed(text);
}

// --- pgvector mode detection -------------------------------------------------

let vectorColumn: boolean | null = null;

/** Test hook: forget the cached pgvector detection (next call re-probes). */
export function resetEmbeddingMode(): void {
  vectorColumn = null;
}

/**
 * True when embeddings.vec is a real pgvector column on the active engine.
 * Remote: PGVECTOR_MIGRATION_SQL (run by ensureRemoteSchema) alters it to
 * vector(1536). Local PGlite: never (0.2.x wasm cannot load pgvector), so
 * detection is skipped and the JSONB cosine path is used.
 * Detected once per process and cached.
 */
export async function hasVectorColumn(): Promise<boolean> {
  if (!hasRemoteDb()) return false;
  if (vectorColumn !== null) return vectorColumn;
  const rows = await query<{ ok: boolean }>(
    `select exists (
       select 1 from information_schema.columns
       where table_name = 'embeddings' and column_name = 'vec' and udt_name = 'vector'
     ) as ok`
  );
  vectorColumn = Boolean(rows[0]?.ok);
  return vectorColumn;
}

/**
 * Similarity search (PRD §6 unstructured retrieval).
 * - Remote Postgres with pgvector (PGVECTOR_MIGRATION_SQL applied): ranked
 *   in-database by the cosine distance operator <=> against the ivfflat index.
 * - Otherwise (local PGlite, JSONB vec): tenant rows are fetched and scored
 *   with in-process cosine.
 * Both paths are tenant-scoped on org_id.
 */
export async function searchSimilar(orgId: string, q: string, limit = 5): Promise<Array<{ title: string | null; content: string; kind: string; score: number }>> {
  const vec = embedVec(q);

  if (await hasVectorColumn()) {
    // pgvector: 1 - cosine distance = cosine similarity. RLS enforces the org
    // filter on the server path; the explicit org_id predicate keeps the plan
    // on the tenant index.
    const rows = await query<{ title: string | null; content: string; kind: string; similarity: number }>(
      `select title, content, kind, 1 - (vec <=> $2::vector) as similarity
       from embeddings where org_id = $1
       order by vec <=> $2::vector
       limit $3`,
      [orgId, JSON.stringify(vec), limit]
    );
    return rows.map((r) => ({ title: r.title, content: r.content, kind: r.kind, score: Number(r.similarity) }));
  }

  // JSONB path (dev / pgvector unavailable): tenant-scoped fetch + TS cosine.
  const rows = await query<{ title: string | null; content: string; kind: string; vec: unknown }>(
    `select title, content, kind, vec from embeddings where org_id = $1 limit 2000`,
    [orgId]
  );
  const scored = rows
    .map((r) => {
      let rv: number[] = [];
      try { rv = typeof r.vec === 'string' ? (JSON.parse(r.vec) as number[]) : (r.vec as number[]); } catch { rv = []; }
      return { title: r.title, content: r.content, kind: r.kind, score: cosine(vec, rv) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    na += a[i]! * a[i]!;
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function chunkText(text: string, size: number): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) {
      out.push(cur.trim());
      cur = p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, 40);
}
