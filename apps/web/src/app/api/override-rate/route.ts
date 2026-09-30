import { getSession } from '@/lib/session';
import { overrideRateReport } from '@factory/agents';

export const runtime = 'nodejs';

/** GET /api/override-rate — weekly % of agent actions overridden (PRD v2 §8). */
export async function GET() {
  const s = await getSession();
  const report = await overrideRateReport(s.orgId);
  return Response.json(report);
}
