import { scanAnomalies } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** GET /api/anomalies — proactive anomaly scan for the dashboard (PRD §9). */
export async function GET() {
  const s = await getSession();
  try {
    const report = await scanAnomalies(s.orgId);
    return Response.json(report);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'anomaly scan failed' }, { status: 500 });
  }
}
