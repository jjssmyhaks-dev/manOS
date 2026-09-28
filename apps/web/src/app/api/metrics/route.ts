import { runMetric, listMetrics } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/** GET /api/metrics?key=sales_last_30d — semantic-layer metric execution. */
export async function GET(req: Request) {
  const s = await getSession();
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return Response.json({ metrics: listMetrics() });
  try {
    const result = await runMetric(s.orgId, key);
    return Response.json({ key, ...result });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'metric failed' }, { status: 400 });
  }
}
