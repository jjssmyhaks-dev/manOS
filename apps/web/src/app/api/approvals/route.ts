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

/**
 * PATCH /api/approvals — human edit of a pending approval's payload before
 * deciding (PRD F7): correct amounts, tweak the reminder message, change the
 * channel. The preview is re-rendered from the edited payload.
 */
export async function PATCH(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as { id: string; payload: Record<string, unknown>; preview?: string };
  if (!body?.id || typeof body.payload !== 'object') {
    return Response.json({ error: 'id and payload required' }, { status: 400 });
  }

  const rows = await query<{ id: string; action_type: string; status: string }>(
    'select id, action_type, status from approvals where id = $1 and org_id = $2 limit 1',
    [body.id, s.orgId]
  );
  const appr = rows[0];
  if (!appr) return Response.json({ error: 'approval not found' }, { status: 404 });
  if (appr.status !== 'pending') return Response.json({ error: `cannot edit a ${appr.status} approval` }, { status: 409 });

  const preview = body.preview?.trim() || renderPreview(appr.action_type, body.payload);
  await query(
    `update approvals set payload = $2::jsonb, preview = $3 where id = $1`,
    [body.id, JSON.stringify(body.payload), preview]
  );
  await audit(s.orgId, `user:${s.userName}`, 'approval.edited', {
    entityId: body.id,
    metadata: { actionType: appr.action_type },
  });
  return Response.json({ ok: true, preview });
}

/** Re-render the human-facing preview for an edited payload. */
function renderPreview(actionType: string, p: Record<string, unknown>): string {
  const v = p as Record<string, string | number | undefined>;
  switch (actionType) {
    case 'send_reminder':
      return `Send ${v.channel ?? 'WhatsApp'} payment reminder to ${v.customer ?? 'customer'} for ${v.invoice ?? 'invoice'} (₹${v.amount ?? 0}, ${v.days ?? 0} days overdue)`;
    case 'send_rfq':
      return `Send RFQ to ${v.vendor ?? 'vendor'} for ${v.qty ?? 0} × ${v.item ?? 'item'}`;
    case 'create_po':
      return `Create PO: ${v.qty ?? 0} × ${v.itemName ?? v.item ?? 'item'} from ${v.vendorName ?? v.vendor ?? 'vendor'} @ ₹${v.rate ?? 0}`;
    case 'tally_push':
      return `Push ${v.voucherType ?? 'voucher'} ${v.voucherNo ?? ''} to Tally`;
    default:
      return `${actionType}: ${JSON.stringify(p).slice(0, 140)}`;
  }
}
