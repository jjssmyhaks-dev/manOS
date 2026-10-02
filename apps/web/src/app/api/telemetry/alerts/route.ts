import { setAlertStatus } from '@factory/agents';
import { getSession } from '@/lib/session';
import { getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * POST /api/telemetry/alerts — maintenance closes the loop on sensor
 * anomalies: { alertId, status: 'acked'|'resolved', note? }. Org-scoped via
 * the session (signed-in workspace or demo org), attributed to the signed-in
 * user, and recorded on the audit trail (agent_actions.status + audit_log) —
 * the same trust path as every other agent action.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { alertId?: string; status?: string; note?: string };
  if (!body.alertId || (body.status !== 'acked' && body.status !== 'resolved')) {
    return Response.json({ error: 'alertId and status (acked|resolved) required' }, { status: 400 });
  }
  const s = await getSession();
  if (s.orgId === 'none') return Response.json({ error: 'no org' }, { status: 400 });
  const user = await getSessionUser();
  const r = await setAlertStatus(s.orgId, body.alertId, body.status, { byUser: user?.email, note: body.note });
  return Response.json(r, { status: r.ok ? 200 : 400 });
}
