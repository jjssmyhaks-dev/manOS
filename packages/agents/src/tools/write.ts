import { tool, jsonSchema } from 'ai';
import { z } from 'zod';
import { query, audit, insertEntity } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import type { AgentContext } from './read.js';

/**
 * Learning memory applied where it matters — before money moves.
 * Active org facts are matched for price floors/ceilings and applied to
 * drafted POs (and mirrored at execution for agent-created SOs), so a
 * correction the owner made in chat ("never sell below ₹350") is enforced
 * mechanically, not just remembered.
 */

interface PriceRule { min?: number; max?: number; fact: string }

async function priceRulesFromFacts(orgId: string): Promise<PriceRule[]> {
  const facts = await query<{ fact: string }>(
    "select fact from org_facts where org_id = $1 and status = 'active'",
    [orgId]
  );
  const rules: PriceRule[] = [];
  for (const { fact } of facts) {
    const amounts = [...fact.matchAll(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi)]
      .map((m) => Number(m[1]!.replace(/,/g, '')))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!amounts.length) continue;
    const amt = amounts[0]!;
    const lower = /below|under|less than|minimum|at least|no less|kam se kam/i.test(fact);
    const upper = /above|over|more than|maximum|not more|up to|zyada/i.test(fact);
    const selling = /sell|selling|quote|quoting|invoice|bill|rate/i.test(fact);
    if (!selling) continue;
    if (lower) rules.push({ min: amt, fact });
    else if (upper) rules.push({ max: amt, fact });
  }
  return rules;
}

/**
 * Write-risk tools: every one routes through the policy engine
 * (auto executes, ask queues an approval, deny refuses) and every execution
 * lands in the audit log.
 */

function previewFor(action: string, payload: Record<string, unknown>): string {
  switch (action) {
    case 'send_reminder': {
      const p = payload as { invoice?: string; customer?: string; amount?: number; days?: number; channel?: string };
      return `Send ${p.channel ?? 'WhatsApp'} payment reminder to ${p.customer ?? 'customer'} for ${p.invoice ?? 'invoice'} (₹${p.amount ?? 0}, ${p.days ?? 0} days overdue)`;
    }
    case 'send_rfq': {
      const p = payload as { vendor?: string; item?: string; qty?: number };
      return `Send RFQ to ${p.vendor ?? 'vendor'} for ${p.qty ?? 0} × ${p.item ?? 'item'}`;
    }
    case 'create_po': {
      const p = payload as { vendor?: string; item?: string; qty?: number; rate?: number };
      return `Create PO: ${p.qty ?? 0} × ${p.item ?? 'item'} from ${p.vendor ?? 'vendor'} @ ₹${p.rate ?? 0}`;
    }
    case 'tally_push': {
      const p = payload as { voucherType?: string; voucherNo?: string };
      return `Push ${p.voucherType ?? 'voucher'} ${p.voucherNo ?? ''} to Tally`;
    }
    case 'send_reminder_batch': {
      const p = payload as { messages?: Array<{ invoice?: string | null; customer?: string; amount?: number; text?: string }> };
      const msgs = p.messages ?? [];
      return msgs.length
        ? `${msgs.length} reminder${msgs.length > 1 ? 's' : ''} ready to send — first: ${msgs[0]!.customer ?? '?'} (${msgs[0]!.invoice ?? '?'})`
        : 'Empty reminder batch';
    }
    case 'create_ncr': {
      const p = payload as { defectType?: string; severity?: string; affectedQty?: number; description?: string };
      return `Open NCR — ${p.defectType ?? 'defect'} (${p.severity ?? 'medium'}) ×${p.affectedQty ?? 1}: ${p.description ?? ''}`.slice(0, 160);
    }
    case 'create_maintenance_wo': {
      const p = payload as { machine?: string; task?: string; dueOn?: string };
      return `Maintenance work order: ${p.task ?? 'PM'} on ${p.machine ?? 'machine'}${p.dueOn ? ` due ${p.dueOn}` : ''}`;
    }
    case 'update_reorder_points': {
      const p = payload as { updates?: Array<{ reorderPoint?: number }> };
      return `Adjust reorder points on ${p.updates?.length ?? 0} item${(p.updates?.length ?? 0) > 1 ? 's' : ''} from the demand forecast`;
    }
    case 'whatsapp_send': {
      const p = payload as { message?: string };
      return `Send owner notification: ${p.message?.slice(0, 80) ?? 'message'}`;
    }
    default:
      return `${action}: ${JSON.stringify(payload).slice(0, 140)}`;
  }
}

/** Human-readable summary + sources per action type (the trust layer). */
function activityFor(actionType: string, payload: Record<string, unknown>): { summary: string; reason?: string; sources: Array<{ type: string; label: string; ref?: string }> } {
  const p = payload as Record<string, string | number | undefined>;
  switch (actionType) {
    case 'send_reminder':
      return {
        summary: `Sent a ${p.channel ?? 'WhatsApp'} payment reminder to ${p.customer ?? 'the customer'} for ${p.invoice ?? 'their invoice'} (₹${Number(p.amount ?? 0).toLocaleString('en-IN')}, ${p.days ?? 0} days overdue)`,
        sources: [{ type: 'invoice', label: `Invoice ${p.invoice}`, ref: p.invoiceId ? String(p.invoiceId) : undefined }],
      };
    case 'send_rfq':
      return {
        summary: `Sent an RFQ to ${p.vendor ?? 'the vendor'} for ${p.qty ?? 0} × ${p.item ?? 'the item'}`, 
        sources: [{ type: 'item', label: `Item ${p.item}`, ref: p.itemId ? String(p.itemId) : undefined }],
      };
    case 'create_po':
      return {
        summary: `Created purchase order ${p.poNo ?? ''} — ${p.qty ?? 0} × ${p.itemName ?? p.item ?? ''} from ${p.vendorName ?? p.vendor ?? ''} @ ₹${p.rate ?? 0}`.replace('  ', ' '),
        sources: [{ type: 'purchase_order', label: `Vendor ${p.vendorName ?? p.vendor}`, ref: p.vendorId ? String(p.vendorId) : undefined }],
      };
    case 'so_create':
      return {
        summary: `Created a sales order for ${p.customer ?? 'the customer'} — ${p.qty ?? 0} × ${p.item ?? ''} @ ₹${p.rate ?? 0}`.replace('  ', ' '),
        sources: [{ type: 'document', label: p.poNumber ? `PO ${p.poNumber}` : 'chat / intake', ref: p.customerId ? String(p.customerId) : undefined }],
      };
    case 'credit_note_draft':
      return {
        summary: `Drafted a credit note of ₹${Number(p.amount ?? 0).toLocaleString('en-IN')} against ${p.invoice ?? 'the invoice'} for ${p.customer ?? 'the customer'} — duplicate billing check`,
        reason: String(p.reason ?? 'Possible duplicate billing detected'),
        sources: [{ type: 'invoice', label: `Invoice ${p.invoice}`, ref: p.invoiceId ? String(p.invoiceId) : undefined }],
      };
    case 'grn_create':
      return { summary: `Posted a goods receipt of ${p.qty ?? 0} units into stock`, sources: [] };
    case 'weighbridge_entry':
      return {
        summary: `Recorded weighbridge entry — ${Number(p.netKg ?? 0).toLocaleString('en-IN')} kg of ${p.grade ?? p.item ?? 'scrap'} from ${p.seller ?? 'the seller'}${p.rate ? ` @ ₹${p.rate}/kg = ₹${Number(p.amount ?? 0).toLocaleString('en-IN')}` : ''}`, 
        reason: p.ticketNo ? `From weighbridge ticket ${p.ticketNo}${p.via === 'whatsapp-photo' ? ' (WhatsApp photo)' : ''}` : undefined,
        sources: [
          { type: 'document', label: p.ticketNo ? `Ticket ${p.ticketNo}` : 'Weighbridge slip' },
          ...(p.itemId ? [{ type: 'item' as const, label: `Rate card: ${p.item}`, ref: String(p.itemId) }] : []),
        ],
      };
    case 'buyer_followup':
      return {
        summary: `Sent export follow-up to ${p.buyer ?? 'the buyer'} — ${p.docSummary ?? 'documents on track'}`,
        sources: [{ type: 'shipment', label: `Shipment ${p.shipmentCode ?? ''}` }],
      };
    case 'job_card_update':
      return { summary: `Updated job card — output ${p.outputQty ?? 0}, rejects ${p.rejectQty ?? 0}`, sources: [{ type: 'job_card', label: 'Job card', ref: p.jobCardId ? String(p.jobCardId) : undefined }] };
    case 'tally_push':
      return { summary: `Queued voucher ${p.voucherNo ?? ''} for the Tally connector`, sources: [] };
    default:
      return { summary: `${actionType.replace(/_/g, ' ')}`, sources: [] };
  }
}

/** Shape of one message inside a send_reminder_batch payload. */
type ParameterizedBatchMessage = { invoice: string | null; customer: string; amount: number; text: string };

/**
 * Execute an approved action (also used by the approvals API) — and record
 * it on the owner-facing AI Activity timeline (F4 trust layer).
 */
export async function executeAction(
  orgId: string,
  actionType: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const res = await executeActionInner(orgId, actionType, payload);
  if (res.ok) {
    try {
      const { recordAgentAction } = await import('../activity.js');
      const a = activityFor(actionType, payload);
      const result = (res.result ?? {}) as { poId?: string; soId?: string; grnId?: string; creditNoteId?: string; purchaseEntryId?: string };
      // what undo needs to reverse, per action kind
      const undoInfo: { kind: 'created_record' | 'outbound'; entityType?: string; entityId?: string } =
        actionType === 'create_po' ? { kind: 'created_record', entityType: 'purchase_entry', entityId: result.poId } :
        actionType === 'so_create' ? { kind: 'created_record', entityType: 'sales_order', entityId: result.soId } :
        actionType === 'grn_create' ? { kind: 'created_record', entityType: 'grn', entityId: result.grnId } :
        actionType === 'credit_note_draft' ? { kind: 'created_record', entityType: 'credit_note', entityId: result.creditNoteId } :
        actionType === 'weighbridge_entry' ? { kind: 'created_record', entityType: 'purchase_entry', entityId: result.purchaseEntryId } :
        { kind: 'outbound' };
      await recordAgentAction({
        orgId,
        actionType,
        summary: a.summary,
        reason: a.reason ?? (payload.__remediationTitle ? `Auto-fix for: ${String(payload.__remediationTitle)}` : undefined),
        sources: a.sources,
        entityType: undoInfo.entityType ?? (actionType === 'send_reminder' ? 'invoice' : undefined),
        entityId: undoInfo.entityId ?? ((payload.invoiceId ?? payload.jobCardId) as string | undefined),
        status: 'executed',
        metadata: { actionType, undo: undoInfo },
      });
    } catch {
      // activity logging must never break an execution
    }
  }
  return res;
}

/** Inner executor (the original switch). */
async function executeActionInner(
  orgId: string,
  actionType: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  switch (actionType) {
    case 'send_reminder': {
      const p = payload as { customerId?: string; customer?: string; invoiceId?: string; invoice?: string; amount?: number; channel?: string; message?: string };
      const channel = p.channel ?? 'whatsapp';
      const body = p.message ?? `Dear ${p.customer ?? 'Sir'}, gentle reminder: invoice ${p.invoice ?? ''} of ₹${p.amount ?? 0} is pending payment. Kindly arrange at the earliest. — Accounts`;
      await query(
        `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,$2,$3,$4,$5,'sent')`,
        [orgId, channel, p.customer ?? null, 'payment_reminder', body]
      );
      if (p.invoiceId) {
        await query(`update entities set data = jsonb_set(data, '{lastReminderAt}', to_jsonb(now()::date)) where org_id=$1 and id=$2`, [orgId, p.invoiceId]);
      }
      return { ok: true, result: { sent: channel, to: p.customer, body } };
    }
    case 'send_rfq': {
      const p = payload as { vendorId?: string; vendor?: string; itemId?: string; item?: string; qty?: number; uom?: string; needBy?: string };
      await insertEntity({
        orgId, type: 'rfq', status: 'sent', partyId: p.vendorId, itemId: p.itemId, qty: p.qty ?? 0,
        source: 'agent', data: { vendor: p.vendor, item: p.item, qty: p.qty, uom: p.uom, needBy: p.needBy, channel: 'email' },
      });
      await query(
        `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'email',$2,'rfq',$3,'sent')`,
        [orgId, p.vendor ?? null, `RFQ: ${p.qty ?? 0} ${p.uom ?? ''} ${p.item ?? ''}. Please quote your best rate and delivery. — Purchase`]
      );
      return { ok: true, result: { rfqSent: true, vendor: p.vendor } };
    }
    case 'create_po': {
      const p = payload as { vendorId?: string; vendor?: string; itemId?: string; item?: string; qty?: number; rate?: number; uom?: string };
      const e = await insertEntity({
        orgId, type: 'purchase_order', status: 'approved', partyId: p.vendorId, itemId: p.itemId,
        qty: p.qty ?? 0, rate: p.rate ?? 0, amount: (p.qty ?? 0) * (p.rate ?? 0),
        source: 'agent', data: { vendor: p.vendor, item: p.item, uom: p.uom, createdBy: 'procurement-agent' },
      });
      // queue a Tally push approval so the accounting system of record is updated only after approval
      await checkPolicyAndQueue(
        {
          orgId, actionType: 'tally_push', entityType: 'purchase_order', entityId: e.id,
          payload: { voucherType: 'Purchase Voucher', voucherNo: e.code, ...p },
          preview: previewFor('tally_push', { voucherType: 'Purchase Voucher', voucherNo: e.code, ...p }),
          risk: 'external',
        },
        async (pl) => executeAction(orgId, 'tally_push', pl as Record<string, unknown>)
      );
      return { ok: true, result: { poId: e.id, poNo: e.code } };
    }
    case 'credit_note_draft': {
      // duplicate-billing fix: a credit note draft against the flagged invoice.
      // Stays a draft until accounts posts it in Tally — we never reduce money
      // owed on our own.
      const p = payload as { invoiceId?: string; invoice?: string; customerId?: string; customer?: string; amount?: number; reason?: string };
      const e = await insertEntity({
        orgId, type: 'credit_note', status: 'draft', partyId: p.customerId,
        amount: p.amount ?? 0, source: 'agent',
        data: { againstInvoiceId: p.invoiceId, againstInvoice: p.invoice, customer: p.customer, reason: p.reason },
      });
      return { ok: true, result: { creditNoteId: e.id, creditNoteNo: e.code } };
    }
    case 'tally_push': {
      // In dev this records the push; the desktop connector picks it up (packages/connectors tally adapter)
      await query(
        `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'connector',$2,'tally_push',$3,'queued')`,
        [orgId, 'tally-connector', JSON.stringify(payload).slice(0, 500)]
      );
      return { ok: true, result: { queuedForConnector: true } };
    }
    case 'so_create': {
      const p = payload as { customerId?: string; customer?: string; itemId?: string; item?: string; qty?: number; rate?: number; poNumber?: string };
      // memory guard: enforce owner price rules at execution time too
      const rules = await priceRulesFromFacts(orgId);
      for (const r of rules) {
        if (r.min != null && (p.rate ?? 0) < r.min) {
          return { ok: false, error: `Blocked by your own rule: “${r.fact}” — rate ₹${p.rate ?? 0} is below ₹${r.min}.` };
        }
        if (r.max != null && (p.rate ?? 0) > r.max) {
          return { ok: false, error: `Blocked by your own rule: “${r.fact}” — rate ₹${p.rate ?? 0} is above ₹${r.max}.` };
        }
      }
      const e = await insertEntity({
        orgId, type: 'sales_order', status: 'confirmed', partyId: p.customerId, itemId: p.itemId,
        qty: p.qty ?? 0, rate: p.rate ?? 0, amount: (p.qty ?? 0) * (p.rate ?? 0), date: new Date().toISOString().slice(0, 10),
        source: 'agent', data: { poNumber: p.poNumber, item: p.item, customer: p.customer, origin: 'document-intake' },
      });
      return { ok: true, result: { soId: e.id, soNo: e.code } };
    }
    case 'weighbridge_entry': {
      // F8 scrap pack: many-small-seller purchase entry from a weighbridge
      // ticket. Recorded as a purchase entry + inward stock movement; posted
      // to Tally only after approval via the connector.
      const p = payload as {
        sellerId?: string; seller?: string; itemId?: string; item?: string; grade?: string;
        netKg?: number; grossKg?: number; tareKg?: number; rate?: number; amount?: number;
        ticketNo?: string; vehicleNo?: string; date?: string; via?: string;
      };
      const e = await insertEntity({
        orgId, type: 'purchase_entry', status: 'recorded', partyId: p.sellerId, itemId: p.itemId,
        qty: p.netKg ?? 0, rate: p.rate ?? 0, amount: p.amount ?? 0,
        date: p.date ?? new Date().toISOString().slice(0, 10),
        source: 'agent',
        data: {
          grade: p.grade ?? null, grossKg: p.grossKg ?? null, tareKg: p.tareKg ?? null,
          ticketNo: p.ticketNo ?? null, vehicleNo: p.vehicleNo ?? null, seller: p.seller ?? null, via: p.via ?? 'web',
        },
      });
      await insertEntity({
        orgId, type: 'stock_ledger', itemId: p.itemId, qty: p.netKg ?? 0,
        date: p.date ?? new Date().toISOString().slice(0, 10), source: 'agent',
        data: { kind: 'inward_scrap', purchaseEntryId: e.id, grade: p.grade ?? null },
      });
      return { ok: true, result: { purchaseEntryId: e.id, code: e.code } };
    }
    case 'send_reminder_batch': {
      // Agent 4 batched approvals: one decision → N individual reminder sends,
      // each logged (spec: "12 reminders ready to send", per-message status)
      const p = payload as { messages: Array<{ invoice?: string | null; customer?: string; amount?: number; text?: string; invoiceId?: string; customerId?: string | null }> };
      const messages = p.messages ?? [];
      if (!messages.length) return { ok: false, error: 'batch has no messages' };
      const { executeSendReminderBatch } = await import('../collections.js');
      return executeSendReminderBatch(orgId, { messages: messages as ParameterizedBatchMessage[] });
    }
    case 'buyer_followup': {
      // F9 export pack: approved buyer follow-up message (queued for dispatch)
      const { sendBuyerFollowUp } = await import('../exports.js');
      return sendBuyerFollowUp(orgId, payload);
    }
    case 'create_ncr': {
      // Agent 9 quality: NCR finalised after approval
      const { executeCreateNcr } = await import('../quality.js');
      return executeCreateNcr(orgId, payload);
    }
    case 'update_reorder_points': {
      // Agent 11 forecasting: batched min/max update after approval
      const { executeUpdateReorderPoints } = await import('../forecast.js');
      return executeUpdateReorderPoints(orgId, payload as { updates: Array<{ itemId: string; reorderPoint: number; reorderQty?: number }> });
    }
    case 'whatsapp_send': {
      // Agent 12 routing notifications (complaint routing) — queued for dispatch
      const p = payload as { message?: string; template?: string };
      await query(
        `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp','owner',$2,$3,'queued')`,
        [orgId, p.template ?? 'whatsapp_send', p.message ?? '']
      );
      return { ok: true, result: { queued: true } };
    }
    case 'create_maintenance_wo': {
      // Agent 13 maintenance: PM work order after approval
      const { executeCreateMaintenanceWo } = await import('../maintenance.js');
      return executeCreateMaintenanceWo(orgId, payload);
    }
    case 'grn_create': {
      const p = payload as { poId?: string; itemId?: string; qty?: number; warehouse?: string };
      const e = await insertEntity({
        orgId, type: 'grn', status: 'posted', itemId: p.itemId, qty: p.qty ?? 0, source: 'agent',
        data: { poId: p.poId, warehouse: p.warehouse },
      });
      await insertEntity({
        orgId, type: 'stock_ledger', itemId: p.itemId, qty: p.qty ?? 0,
        source: 'agent', data: { kind: 'inward', grnId: e.id },
      });
      return { ok: true, result: { grnId: e.id } };
    }
    case 'job_card_update': {
      const p = payload as { jobCardId?: string; status?: string; outputQty?: number; rejectQty?: number };
      if (p.jobCardId) {
        await query(
          `update entities set data = data || $3::jsonb, status = coalesce($2, status) where org_id=$1 and id=$4`,
          [orgId, p.status ?? null, JSON.stringify({ lastUpdate: p, updatedAt: new Date().toISOString() }), p.jobCardId]
        );
      }
      return { ok: true, result: { updated: p.jobCardId } };
    }
    default:
      return { ok: false, error: `No executor for action '${actionType}'` };
  }
}

// --- Agent-facing write tools -------------------------------------------------
// NOTE: inputSchema uses jsonSchema() rather than zod for these write tools —
// the AI SDK's zod3/zod4 dual-build validator mis-bounded in the Next webpack
// bundle and rejected valid empty inputs; raw JSON schemas bypass that path.

export const draftRemindersTool = (ctx: AgentContext) =>
  tool({
    description: 'Draft and queue payment reminders for overdue invoices. Outbound messages are queued for approval by policy.',
    inputSchema: jsonSchema<{
      minDaysOverdue?: number;
      limit?: number;
      channel?: 'whatsapp' | 'email';
    }>({
      type: 'object',
      properties: {
        minDaysOverdue: { type: 'integer', minimum: 0, description: 'Only invoices overdue at least this many days' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max invoices to draft (default 10)' },
        channel: { type: 'string', enum: ['whatsapp', 'email'], description: 'Outbound channel (default whatsapp)' },
      },
      additionalProperties: false,
    }),
    execute: async ({ minDaysOverdue, limit, channel }) => {
      const res = await runOverdue(ctx.orgId, minDaysOverdue ?? 1, limit ?? 10);
      const queued: string[] = [];
      for (const inv of res) {
        const payload = {
          invoiceId: inv.id, invoice: inv.invoice, customerId: inv.customerId, customer: inv.customer,
          amount: inv.amount, days: inv.overdueDays, channel: channel ?? 'whatsapp',
        };
        const r = await checkPolicyAndQueue(
          {
            orgId: ctx.orgId, actionType: 'send_reminder', entityType: 'invoice', entityId: inv.id,
            payload, preview: previewFor('send_reminder', payload), risk: 'external',
          },
          (pl) => executeAction(ctx.orgId, 'send_reminder', pl as Record<string, unknown>)
        );
        queued.push(`${inv.invoice}: ${r.decision}${r.approvalId ? ` (${r.approvalId})` : ''} — ${r.reason}`);
      }
      return { queuedCount: queued.length, details: queued };
    },
  });

export const draftRfqTool = (ctx: AgentContext) =>
  tool({
    description: 'Draft RFQs to preferred vendors for low-stock items. Queued for approval by policy.',
    inputSchema: jsonSchema<{ itemNames?: string[] }>({
      type: 'object',
      properties: {
        itemNames: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Limit to these items; default: all low-stock items',
        },
      },
      additionalProperties: false,
    }),
    execute: async ({ itemNames }) => {
      const low = await runLowStock(ctx.orgId);
      const targets = itemNames?.length ? low.items.filter((i) => itemNames.some((n) => (i.item ?? '').toLowerCase().includes(n.toLowerCase()))) : low.items;
      const vendors = low.vendors.filter((v) => v.preferred);
      const pool = vendors.length ? vendors : low.vendors;
      const queued: string[] = [];
      for (const item of targets) {
        const vendor = pool[0];
        if (!vendor) { queued.push(`${item.item}: no vendor on file`); continue; }
        const payload = {
          vendorId: vendor.vendorId, vendor: vendor.name, itemId: item.itemId, item: item.item,
          qty: item.suggestedQty, uom: item.uom, needBy: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
        };
        const r = await checkPolicyAndQueue(
          {
            orgId: ctx.orgId, actionType: 'send_rfq', entityType: 'item', entityId: item.itemId,
            payload, preview: previewFor('send_rfq', payload), risk: 'external',
          },
          (pl) => executeAction(ctx.orgId, 'send_rfq', pl as Record<string, unknown>)
        );
        queued.push(`${item.item} → ${vendor.name}: ${r.decision}${r.approvalId ? ` (${r.approvalId})` : ''}`);
      }
      return { queuedCount: queued.length, details: queued };
    },
  });

export const createPoDraftTool = (ctx: AgentContext) =>
  tool({
    description: 'Create a purchase order draft for a vendor/item/qty/rate. Queued for approval by policy; POs also queue a Tally push.',
    inputSchema: jsonSchema<{
      vendorName: string;
      itemName: string;
      qty: number;
      rate: number;
      uom?: string;
    }>({
      type: 'object',
      properties: {
        vendorName: { type: 'string', description: 'Vendor name (resolved to record)' },
        itemName: { type: 'string', description: 'Item name (resolved to record)' },
        qty: { type: 'number', exclusiveMinimum: 0 },
        rate: { type: 'number', exclusiveMinimum: 0 },
        uom: { type: 'string' },
      },
      required: ['vendorName', 'itemName', 'qty', 'rate'],
      additionalProperties: false,
    }),
    execute: async (p) => {
      // resolve names → ids so the model never needs to know database ids
      const itemRows = await query<{ id: string }>(
        `select id from entities where org_id=$1 and type='item' and coalesce(name, data->>'name') ilike $2 limit 1`,
        [ctx.orgId, `%${p.itemName}%`]
      );
      if (!itemRows[0]) return { decision: 'deny' as const, reason: `Item '${p.itemName}' not found in item master.` };
      const vendorRows = await query<{ id: string; name: string | null }>(
        `select id, coalesce(name, data->>'name') as name from entities where org_id=$1 and type='party' and data->>'kind'='vendor' and coalesce(name, data->>'name') ilike $2 limit 1`,
        [ctx.orgId, `%${p.vendorName}%`]
      );
      if (!vendorRows[0]) return { decision: 'deny' as const, reason: `Vendor '${p.vendorName}' not found in party master.` };
      // memory guard: warn when the draft violates a learned price rule
      const rules = await priceRulesFromFacts(ctx.orgId);
      for (const r of rules) {
        if (r.max != null && p.rate > r.max) {
          return {
            decision: 'deny' as const,
            reason: `Your own rule says: “${r.fact}”. Drafted rate ₹${p.rate} exceeds it — adjust the rate or update the rule in Settings.`,
          };
        }
        if (r.min != null && p.rate < r.min) {
          return {
            decision: 'deny' as const,
            reason: `Your own rule says: “${r.fact}”. Drafted rate ₹${p.rate} is below it — adjust the rate or update the rule in Settings.`,
          };
        }
      }
      const payload = {
        vendorId: vendorRows[0].id, vendorName: vendorRows[0].name ?? p.vendorName,
        itemId: itemRows[0].id, itemName: p.itemName, qty: p.qty, rate: p.rate, uom: p.uom,
      };
      const r = await checkPolicyAndQueue(
        {
          orgId: ctx.orgId, actionType: 'create_po', entityType: 'purchase_order',
          payload, preview: previewFor('create_po', payload), risk: 'write',
        },
        (pl) => executeAction(ctx.orgId, 'create_po', pl as Record<string, unknown>)
      );
      return { decision: r.decision, approvalId: r.approvalId, reason: r.reason };
    },
  });

export const logShiftOutputTool = (ctx: AgentContext) =>
  tool({
    description: 'Log shift output/rejects/downtime against a job card (from WhatsApp voice or form).',
    inputSchema: jsonSchema<{
      jobCardCode: string;
      outputQty: number;
      rejectQty?: number;
      downtimeMins?: number;
      note?: string;
    }>({
      type: 'object',
      properties: {
        jobCardCode: { type: 'string', description: 'Job card code, e.g. JC-101' },
        outputQty: { type: 'integer', minimum: 0 },
        rejectQty: { type: 'integer', minimum: 0 },
        downtimeMins: { type: 'integer', minimum: 0 },
        note: { type: 'string' },
      },
      required: ['jobCardCode', 'outputQty'],
      additionalProperties: false,
    }),
    execute: async ({ jobCardCode, outputQty, rejectQty, downtimeMins, note }) => {
      const rows = await query<{ id: string }>(
        `select id from entities where org_id=$1 and type='job_card' and code=$2 limit 1`,
        [ctx.orgId, jobCardCode]
      );
      if (!rows[0]) return { ok: false, error: `Job card ${jobCardCode} not found` };
      const payload = { jobCardId: rows[0].id, status: 'running', outputQty, rejectQty: rejectQty ?? 0, downtimeMins: downtimeMins ?? 0, note };
      const r = await checkPolicyAndQueue(
        { orgId: ctx.orgId, actionType: 'job_card_update', entityType: 'job_card', entityId: rows[0].id, payload, preview: `Log shift output for ${jobCardCode}: output ${outputQty}, rejects ${rejectQty ?? 0}`, risk: 'write' },
        (pl) => executeAction(ctx.orgId, 'job_card_update', pl as Record<string, unknown>)
      );
      return { decision: r.decision, approvalId: r.approvalId, reason: r.reason };
    },
  });

// helpers --------------------------------------------------------------------

async function runOverdue(orgId: string, minDays: number, limit: number) {
  const rows = await query<{ id: string; code: string | null; party_id: string | null; amount: string; overdue_days: string }>(
    `select id, code, party_id, amount, (current_date - (data->>'dueDate')::date) as overdue_days
     from entities
     where org_id=$1 and type='invoice' and status in ('sent','overdue','partial')
       and data->>'dueDate' is not null and (data->>'dueDate')::date < current_date
     order by (data->>'dueDate')::date asc limit $2`,
    [orgId, limit]
  );
  const ids = [...new Set(rows.map((r) => r.party_id).filter(Boolean) as string[])];
  const parties = ids.length ? await query<{ id: string; name: string }>(`select id, coalesce(name, data->>'name') as name from entities where org_id=$1 and id = any($2)`, [orgId, ids]) : [];
  const names = new Map(parties.map((p) => [p.id, p.name]));
  return rows
    .map((r) => ({
      id: r.id, invoice: r.code, customerId: r.party_id, customer: names.get(r.party_id ?? '') ?? 'Unknown',
      amount: Number(r.amount), overdueDays: Number(r.overdue_days),
    }))
    .filter((r) => r.overdueDays >= minDays);
}

async function runLowStock(orgId: string) {
  const rows = await query<{ id: string; name: string | null; soh: string; rop: string; rq: string; uom: string | null }>(
    `select id, coalesce(name, data->>'name') as name, (data->>'stockOnHand') as soh, (data->>'reorderPoint') as rop,
            (data->>'reorderQty') as rq, (data->>'uom') as uom
     from entities where org_id=$1 and type='item'
       and (data->>'stockOnHand')::numeric <= (data->>'reorderPoint')::numeric`,
    [orgId]
  );
  const vendors = await query<{ id: string; name: string | null; pref: boolean }>(
    `select id, coalesce(name, data->>'name') as name, coalesce((data->>'preferred')::boolean, false) as pref
     from entities where org_id=$1 and type='party' and data->>'kind'='vendor'`,
    [orgId]
  );
  return {
    items: rows.map((r) => ({ itemId: r.id, item: r.name, stockOnHand: Number(r.soh), reorderPoint: Number(r.rop), suggestedQty: Number(r.rq), uom: r.uom })),
    vendors: vendors.map((v) => ({ vendorId: v.id, name: v.name ?? '', preferred: v.pref })),
  };
}

export function writeToolDefs(ctx: AgentContext) {
  return {
    draft_reminders: draftRemindersTool(ctx),
    draft_reminders_batch: draftRemindersBatchTool(ctx),
    draft_rfq: draftRfqTool(ctx),
    create_po_draft: createPoDraftTool(ctx),
    compare_vendor_quotes: compareVendorQuotesTool(ctx),
    log_shift_output: logShiftOutputTool(ctx),
    forecast_reorder_points: forecastReorderPointsTool(ctx),
    log_inspection: logInspectionTool(ctx),
    log_defect_ncr: logDefectNcrTool(ctx),
    check_maintenance: checkMaintenanceTool(ctx),
    draft_maintenance_wo: draftMaintenanceWoTool(ctx),
  };
}

// --- Agent 4 batch + Agent 5 quote comparison ---------------------------------

/** Batched reminder drafts (spec A4: ONE approvals item, N previewable messages). */
export const draftRemindersBatchTool = (ctx: AgentContext) =>
  tool({
    description:
      'Draft payment reminders for ALL eligible overdue invoices as a single batch approval (respects per-org reminder cooldown and open promise-to-pay dates). Prefer this over individual reminders when more than one invoice is overdue.',
    inputSchema: jsonSchema<{ minDaysOverdue?: number }>({
      type: 'object',
      properties: {
        minDaysOverdue: { type: 'integer', minimum: 0, description: 'Only invoices overdue at least this many days (default 1)' },
      },
      additionalProperties: false,
    }),
    execute: async ({ minDaysOverdue }) => {
      const { batchDraftReminders } = await import('../collections.js');
      const res = await batchDraftReminders(ctx.orgId, { minDaysOverdue });
      return {
        decision: res.decision,
        approvalId: res.approvalId,
        count: res.count,
        totalAmount: res.totalAmount,
        previewFirst: res.messages[0]?.text,
        reason: res.reason,
      };
    },
  });

/** Unstructured vendor replies → a comparable table (spec A5 compareQuotes). */
export const compareVendorQuotesTool = (ctx: AgentContext) =>
  tool({
    description:
      'Compare vendor quote replies for an RFQ: pass each vendor reply (verbatim text or already-structured numbers) and get a sorted comparison with the recommended pick — lowest quoted rate meeting the required-by date, preferred vendors first on ties.',
    inputSchema: jsonSchema<{
      rfqCode: string;
      requiredBy?: string;
      quotes: Array<{ vendorName: string; replyText?: string; rate?: number; leadTimeDays?: number; minQty?: number; note?: string }>;
    }>({
      type: 'object',
      properties: {
        rfqCode: { type: 'string', description: 'RFQ code these replies answer, e.g. RFQ-0012' },
        requiredBy: { type: 'string', description: 'YYYY-MM-DD need-by date for lead-time filtering' },
        quotes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              vendorName: { type: 'string' },
              replyText: { type: 'string', description: 'Verbatim vendor reply — rate/lead time are parsed from it when the numeric fields are absent' },
              rate: { type: 'number' },
              leadTimeDays: { type: 'number' },
              minQty: { type: 'number' },
              note: { type: 'string' },
            },
            required: ['vendorName'],
            additionalProperties: false,
          },
        },
      },
      required: ['rfqCode', 'quotes'],
      additionalProperties: false,
    }),
    execute: async ({ rfqCode, requiredBy, quotes }) => {
      const { compareVendorQuotes } = await import('../procurement.js');
      const res = await compareVendorQuotes(ctx.orgId, rfqCode, quotes, requiredBy);
      return res;
    },
  });

// --- Agent 9 / 11 / 13 agent-facing surfaces -----------------------------------

/** Agent 11: forecast + batched reorder-point update in one call. */
export const forecastReorderPointsTool = (ctx: AgentContext) =>
  tool({
    description:
      'Run the demand-forecast cycle: per-item reorder-point suggestions from sales history (insufficient-history and seasonal items flagged, not guessed), queued as ONE approval that updates item min/max on approval.',
    inputSchema: jsonSchema<{ horizonWeeks?: number }>({
      type: 'object',
      properties: {
        horizonWeeks: { type: 'integer', minimum: 1, maximum: 12, description: 'Planning horizon (default 4)' },
      },
      additionalProperties: false,
    }),
    execute: async ({ horizonWeeks }) => {
      const { runForecastCycle } = await import('../forecast.js');
      const r = await runForecastCycle(ctx.orgId, horizonWeeks ?? 4);
      return {
        suggestions: r.suggestions.map((s) => ({ item: s.item, from: s.currentReorderPoint, to: s.suggestedReorderPoint, why: s.why })),
        insufficientHistory: r.insufficientHistory,
        seasonal: r.seasonal,
        decision: r.decision,
        approvalId: r.approvalId,
      };
    },
  });

/** Agent 9 checklist path: record an inspection (auto-escalates on failure). */
export const logInspectionTool = (ctx: AgentContext) =>
  tool({
    description:
      'Record a completed inspection checklist for an item/job card. Any failed item marks the inspection for NCR follow-up.',
    inputSchema: jsonSchema<{
      itemRef?: string;
      jobCardCode?: string;
      checklistKey?: string;
      results: Array<{ item: string; pass: boolean; note?: string }>;
    }>({
      type: 'object',
      properties: {
        itemRef: { type: 'string', description: 'Item name or code' },
        jobCardCode: { type: 'string' },
        checklistKey: { type: 'string', description: 'Which checklist, e.g. dispatch_qc' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', description: 'Checklist line' },
              pass: { type: 'boolean' },
              note: { type: 'string' },
            },
            required: ['item', 'pass'],
            additionalProperties: false,
          },
        },
      },
      required: ['results'],
      additionalProperties: false,
    }),
    execute: async (p) => {
      const { createInspectionRecord } = await import('../quality.js');
      const r = await createInspectionRecord(ctx.orgId, p);
      return { inspectionId: r.inspectionId, failed: r.failed, ncrRecommended: r.failed > 0 };
    },
  });

/** Agent 9 photo path: structured defect → NCR/CAPA draft through policy. */
export const logDefectNcrTool = (ctx: AgentContext) =>
  tool({
    description:
      'Draft an NCR (non-conformance report) for a defect: type, severity, qty affected, description. Similar past defects are pulled in for root-cause suggestions; a CAPA draft rides along. Queued for approval — NCRs touch supplier/customer relationships.',
    inputSchema: jsonSchema<{
      defectType: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      affectedQty?: number;
      description: string;
      itemRef?: string;
      jobCardCode?: string;
    }>({
      type: 'object',
      properties: {
        defectType: { type: 'string', description: 'scratch, dent, dimensional-off, porosity, colour, leak…' },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        affectedQty: { type: 'integer', minimum: 1 },
        description: { type: 'string' },
        itemRef: { type: 'string' },
        jobCardCode: { type: 'string' },
      },
      required: ['defectType', 'severity', 'description'],
      additionalProperties: false,
    }),
    execute: async (p) => {
      const { draftNcr } = await import('../quality.js');
      const r = await draftNcr(
        ctx.orgId,
        { defectType: p.defectType, severity: p.severity, affectedQty: p.affectedQty ?? 1, description: p.description },
        { itemRef: p.itemRef, jobCardCode: p.jobCardCode, source: 'manual' }
      );
      return { decision: r.decision, approvalId: r.approvalId, trendAlert: r.trendAlert, similar: r.similar, reason: r.reason };
    },
  });

/** Agent 13 read: what PM work is due. */
export const checkMaintenanceTool = (ctx: AgentContext) =>
  tool({
    description: 'Preventive-maintenance check: machines due within the warning window (calendar intervals), plus machines missing an interval.',
    inputSchema: jsonSchema<{}>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      const { checkDueMaintenance } = await import('../maintenance.js');
      const r = await checkDueMaintenance(ctx.orgId);
      return {
        due: r.due.map((d) => ({ machine: d.machine, dueOn: d.dueOn, daysOverdue: d.daysOverdue, interval: d.pmIntervalDays })),
        missingInterval: r.missingInterval,
        machines: r.total,
      };
    },
  });

/** Agent 13 write: draft PM work orders for everything due. */
export const draftMaintenanceWoTool = (ctx: AgentContext) =>
  tool({
    description: 'Draft preventive-maintenance work orders for all machines due (calendar basis, recorded explicitly); each queues through approvals.',
    inputSchema: jsonSchema<{}>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      const { draftMaintenanceWorkOrders } = await import('../maintenance.js');
      const r = await draftMaintenanceWorkOrders(ctx.orgId);
      return { drafts: r.drafts, missingInterval: r.missingInterval };
    },
  });
