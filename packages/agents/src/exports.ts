import { query, insertEntity, audit } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { executeAction } from './tools/write.js';
import { recordAgentAction } from './activity.js';

/**
 * F9 export pack (PRD v2 §7): the agent watches export-document deadlines —
 * LUT renewal, pending packing lists / commercial invoices, buyer follow-ups —
 * drafts the outstanding doc + a WhatsApp message to the buyer, the sales
 * owner approves, and status is tracked until closed.
 */

export interface ExportDeadline {
  kind: 'lut_expiry' | 'packing_list_pending' | 'commercial_invoice_pending' | 'iec_expiry';
  shipmentCode: string | null;
  buyer: string | null;
  dueInDays: number;
  detail: string;
  severity: 'high' | 'medium';
}

/** LUT/IEC are stored as entities type='export_doc' with data.kind + data.validTill. */
export async function checkExportDeadlines(orgId: string): Promise<ExportDeadline[]> {
  const out: ExportDeadline[] = [];

  const docs = await query<{ id: string; code: string | null; kind: string | null; valid_till: string | null; buyer: string | null }>(
    `select id, code, data->>'kind' as kind, data->>'validTill' as valid_till, data->>'buyer' as buyer
     from entities where org_id = $1 and type = 'export_doc' and data->>'validTill' is not null`,
    [orgId]
  );
  const today = new Date();
  for (const d of docs) {
    if (!d.valid_till) continue;
    const days = Math.ceil((new Date(d.valid_till).getTime() - today.getTime()) / 86400_000);
    if (days > 30) continue;
    out.push({
      kind: d.kind === 'iec' ? 'iec_expiry' : 'lut_expiry',
      shipmentCode: d.code,
      buyer: d.buyer,
      dueInDays: days,
      detail: days < 0
        ? `${d.kind === 'iec' ? 'IEC' : 'LUT'} ${d.code ?? ''} EXPIRED ${Math.abs(days)} days ago — shipments without it lose the zero-rated benefit.`
        : `${d.kind === 'iec' ? 'IEC' : 'LUT'} ${d.code ?? ''} expires in ${days} day${days === 1 ? '' : 's'}.`,
      severity: days < 7 ? 'high' : 'medium',
    });
  }

  const shipments = await query<{ id: string; code: string | null; buyer: string | null; docs: Record<string, unknown> | null }>(
    `select id, code, data->>'buyer' as buyer, data->>'docs' as docs
     from entities where org_id = $1 and type = 'shipment' and status not in ('closed','cancelled')
     order by created_at desc limit 50`,
    [orgId]
  );
  for (const s of shipments) {
    const docs = (s.docs ?? {}) as { packingList?: boolean; commercialInvoice?: boolean };
    const buyer = s.buyer ?? 'the buyer';
    if (!docs.packingList) {
      out.push({ kind: 'packing_list_pending', shipmentCode: s.code, buyer, dueInDays: 3, detail: `Packing list pending for shipment ${s.code ?? ''} to ${buyer}.`, severity: 'medium' });
    }
    if (!docs.commercialInvoice) {
      out.push({ kind: 'commercial_invoice_pending', shipmentCode: s.code, buyer, dueInDays: 3, detail: `Commercial invoice pending for shipment ${s.code ?? ''} to ${buyer}.`, severity: 'medium' });
    }
  }

  return out.sort((a, b) => a.dueInDays - b.dueInDays);
}

export interface FollowUpDraft {
  ok: boolean;
  shipmentCode: string | null;
  message: string;
  docSummary: string;
  decision?: string;
  approvalId?: string;
  error?: string;
}

/** Draft the outstanding document note + buyer WhatsApp message (via policy). */
export async function draftBuyerFollowUp(orgId: string, deadline: ExportDeadline): Promise<FollowUpDraft> {
  const docSummary = deadline.kind === 'lut_expiry' || deadline.kind === 'iec_expiry'
    ? `Renew the ${deadline.kind === 'lut_expiry' ? 'LUT' : 'IEC'} (validity ${deadline.dueInDays < 0 ? 'expired' : `ends in ${deadline.dueInDays}d`})`
    : `Prepare the ${deadline.kind === 'packing_list_pending' ? 'packing list' : 'commercial invoice'} for ${deadline.shipmentCode ?? 'the shipment'}`;

  const message = [
    `Dear ${deadline.buyer ?? 'Sir'},`,
    '',
    deadline.kind === 'packing_list_pending'
      ? `Sharing the packing list for shipment ${deadline.shipmentCode ?? ''} shortly. Kindly confirm the discharge port details so documentation stays on schedule.`
      : deadline.kind === 'commercial_invoice_pending'
        ? `The commercial invoice for shipment ${deadline.shipmentCode ?? ''} is being finalised and will reach you today.`
        : `Quick update on our export schedule — all documents for ${deadline.shipmentCode ?? 'your order'} are on track.`,
    '',
    '— Exports desk',
  ].join('\n');

  const payload = {
    kind: deadline.kind,
    shipmentCode: deadline.shipmentCode,
    buyer: deadline.buyer,
    docSummary,
    message,
    channel: 'whatsapp',
  };
  const r = await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'buyer_followup',
      entityType: 'shipment',
      payload,
      preview: `Send buyer follow-up to ${deadline.buyer ?? 'buyer'} — ${docSummary.toLowerCase()}`,
      risk: 'external',
    },
    (pl) => executeAction(orgId, 'buyer_followup', pl as Record<string, unknown>)
  );
  return { ok: r.decision !== 'deny', shipmentCode: deadline.shipmentCode, message, docSummary, decision: r.decision, approvalId: r.approvalId };
}

/** Approve-and-send path: records the send on the activity log. */
export async function sendBuyerFollowUp(orgId: string, payload: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown }> {
  const p = payload as { buyer?: string; message?: string; shipmentCode?: string; docSummary?: string };
  await query(
    `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'buyer_followup',$3,'queued')`,
    [orgId, p.buyer ?? 'buyer', p.message ?? '']
  );
  const action = await recordAgentAction({
    orgId,
    actionType: 'buyer_followup',
    summary: `Sent export follow-up to ${p.buyer ?? 'the buyer'} — ${p.docSummary ?? 'documents on track'}${p.shipmentCode ? ` (${p.shipmentCode})` : ''}`,
    reason: 'Deadline detected by the export document watch',
    sources: [{ type: 'shipment', label: `Shipment ${p.shipmentCode ?? ''}` }],
    entityType: 'message',
    entityId: p.shipmentCode ?? undefined,
    status: 'executed',
  });
  await audit(orgId, 'agent', 'exports.followup_sent', { entityId: action.id, metadata: { shipment: p.shipmentCode } });
  return { ok: true, result: { sent: true, activityId: action.id } };
}

/** Digest/dashboard lines. */
export function exportFollowupLines(deadlines: ExportDeadline[], max = 5): string[] {
  if (deadlines.length === 0) return [];
  return deadlines.slice(0, max).map((d) => `${d.severity === 'high' ? '🔴' : '🟡'} ${d.detail}`);
}
