import { machineHealthSnapshot } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/**
 * GET /api/telemetry/machines — the dashboard machine-health feed (A13 P2b):
 * per-machine latest readings vs baselines with live deviation, 7-day
 * anomaly counts, and the recent anomaly history. Read-only, org-scoped.
 */
export async function GET() {
  const s = await getSession();
  if (s.orgId === 'none') return Response.json({ error: 'no org' }, { status: 400 });
  const snap = await machineHealthSnapshot(s.orgId);
  return Response.json({ ok: true, ...snap });
}
