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
    default:
      return `${action}: ${JSON.stringify(payload).slice(0, 140)}`;
  }
}

/** Execute an approved action (also used by the approvals API). */
export async function executeAction(
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
    case 'grn_create': {
      const p = payload as { poId?: string; itemId?: string; qty?: number; warehouse?: string };
      const e = await insertEntity({
        orgId, type: 'grn', status: 'posted', itemId: p.itemId, qty: p.qty ?? 0, source: 'agent',
        data: { poId: p.poId, warehouse: p.warehouse },
      });
      await query(
        `insert into entities (org_id, type, item_id, qty, date, source, data) values ($1,'stock_ledger',$2,$3,current_date,'agent', $4::jsonb)`,
        [orgId, p.itemId ?? null, p.qty ?? 0, JSON.stringify({ kind: 'inward', grnId: e.id })]
      );
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
    draft_rfq: draftRfqTool(ctx),
    create_po_draft: createPoDraftTool(ctx),
    log_shift_output: logShiftOutputTool(ctx),
  };
}
