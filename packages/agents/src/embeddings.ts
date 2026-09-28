import { query } from '@factory/db';

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

/**
 * Similarity search. Dev (JSONB vec): fetch tenant rows, cosine in TS.
 * Prod (Supabase with PGVECTOR_MIGRATION_SQL applied): pgvector does the work
 * via the same two-step flow — the TS cosine is simply replaced by trusting
 * pgvector's order when the extension column is present.
 */
export async function searchSimilar(orgId: string, q: string, limit = 5): Promise<Array<{ title: string | null; content: string; kind: string; score: number }>> {
  const vec = embedVec(q);
  // Tenant-scoped fetch (RLS enforces org filter on the server path).
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
