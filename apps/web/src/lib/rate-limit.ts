/**
 * In-memory sliding-window rate limiter for high-risk API routes.
 *
 * Production topology note: one limiter per server instance. On Vercel
 * serverless (the default deploy) instances are short-lived and independent,
 * so this bounds the abuse an *individual* request-handling instance can
 * absorb — cheap and zero-infra. For a long-lived single-node deploy it is a
 * true limiter. When traffic grows, swap in Upstash Redis (`@upstash/ratelimit`)
 * behind the same `limit()` signature — call sites don't change.
 */

const buckets = new Map<string, number[]>();

export interface LimitResult {
  ok: boolean;
  retryAfterSec: number;
}

/** Allow max hits per windowSec for a key (e.g. `ip` or `email`). */
export function limit(key: string, max = 10, windowSec = 60): LimitResult {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - hits[0]!)) / 1000) };
  }
  hits.push(now);
  buckets.set(key, hits);
  // opportunistic sweep so the map cannot grow without bound
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
  return { ok: true, retryAfterSec: 0 };
}

/** Best-effort client identity for limiting: proxy IP or a given identifier. */
export function clientKey(req: Request, extra?: string): string {
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = fwd || req.headers.get('x-real-ip') || 'unknown';
  return extra ? `${ip}|${extra}` : ip;
}
