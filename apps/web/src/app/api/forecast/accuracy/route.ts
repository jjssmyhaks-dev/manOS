import { forecastAccuracySummary } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/**
 * GET /api/forecast/accuracy — how the AI's demand projections compared to
 * actual sales (A11 trust surface). Powers the Settings card; the daily and
 * pilot digests carry the same numbers so owners see the misses in WhatsApp
 * too, not just here.
 */
export async function GET() {
  const s = await getSession();
  if (s.orgId === 'none') return Response.json({ error: 'no org' }, { status: 400 });
  const summary = await forecastAccuracySummary(s.orgId, 5);
  return Response.json({ ok: true, ...summary });
}
