import { query, audit } from '@factory/db';
import { decideApproval } from '@factory/core';
import { executeAction } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/** GET /api/approvals — approvals inbox list (PRD F7). */
export async function GET() {
  const s = await getSession();
  const rows = await query(
    `select id, action_type, entity_type, entity_id, payload, preview, risk, status, requested_by, decided_by, decided_at, result, created_at
     from approvals where org_id = $1 order by created_at desc limit 100`,
    [s.orgId]
  );
  return Response.json({ approvals: rows });
}

/** POST /api/approvals — decide (approve/reject) → executes via executor. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as { id: string; decision: 'approve' | 'reject' };
  if (!body?.id || !body?.decision) return Response.json({ error: 'id and decision required' }, { status: 400 });

  const rows = await query<{ action_type: string }>('select action_type from approvals where id = $1', [body.id]);
  const actionType = rows[0]?.action_type;
  if (!actionType) return Response.json({ error: 'approval not found' }, { status: 404 });

  const res = await decideApproval(body.id, body.decision, `user:${s.userName}`, (payload) =>
    executeAction(s.orgId, actionType, payload as Record<string, unknown>)
  );
  await audit(s.orgId, `user:${s.userName}`, `approvals.${body.decision}`, { entityId: body.id, metadata: { actionType } });
  return Response.json({ ok: true, ...res });
}
