import { query } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { executeAction } from './tools/write.js';
import { recordAgentAction } from './activity.js';

/**
 * Agent 4 — Collections (PRD F6): overdue receivables tracked with reminder
 * discipline. The scheduled run honours two human behaviours that naive
 * automations get wrong: a COOLDOWN between reminders (don't nag daily) and
 * PROMISE-TO-PAY records (stop chasing customers who have committed to a
 * date). Drafts batch into ONE approvals item ("12 reminders ready") with
 * each message previewable and individually editable; on approval, per-message
 * delivery is logged. Replies come back through the webhook as suggested
 * promise-to-pay entries for human confirmation — never auto-applied.
 *
 * Templates live in config (collections_config on org settings) with the
 * deterministic {customer}/{invoice}/{amount}/{days}/{date} placeholders —
 * the LLM is not in this hot path, so nothing can hallucinate an amount.
 */

export const REMINDER_COOLDOWN_DAYS = 7; // config default, overridable per org

export interface OverdueCandidate {
  invoiceId: string;
  invoice: string | null;
  customerId: string | null;
  customer: string;
  amount: number;
  overdueDays: number;
  lastReminderAt: string | null;
  promisedFor: string | null;
  skippedReason?: 'cooldown' | 'promise';
}

/** Overdue invoices that are actually eligible for a reminder right now. */
export async function getReminderCandidates(
  orgId: string,
  minDaysOverdue = 1,
  cooldownDays = REMINDER_COOLDOWN_DAYS
): Promise<{ eligible: OverdueCandidate[]; skipped: OverdueCandidate[] }> {
  const rows = await query<{
    id: string;
    code: string | null;
    party_id: string | null;
    amount: string;
    overdue_days: string;
    last_reminder: string | null;
    promised_for: string | null;
    customer: string | null;
  }>(
    `select e.id, e.code, e.party_id, e.amount,
            (current_date - (e.data->>'dueDate')::date) as overdue_days,
            e.data->>'lastReminderAt' as last_reminder,
            ptp.promised_for,
            coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), '(unknown)') as customer
     from entities e
     left join (
       select (data->>'invoiceId') as inv_id, max(data->>'promiseDate') as promised_for
       from entities where org_id = $1 and type = 'promise_to_pay' and status = 'pending'
       group by (data->>'invoiceId')
     ) ptp on ptp.inv_id = e.id
     where e.org_id = $1 and e.type = 'invoice' and e.status in ('sent','overdue','partial')
       and e.data->>'dueDate' is not null and (e.data->>'dueDate')::date < current_date
     order by (e.data->>'dueDate')::date asc limit 100`,
    [orgId]
  );

  const eligible: OverdueCandidate[] = [];
  const skipped: OverdueCandidate[] = [];
  for (const r of rows) {
    const days = Number(r.overdue_days);
    if (days < minDaysOverdue) continue;
    const c: OverdueCandidate = {
      invoiceId: r.id,
      invoice: r.code,
      customerId: r.party_id,
      customer: r.customer ?? '(unknown)',
      amount: Number(r.amount),
      overdueDays: days,
      lastReminderAt: r.last_reminder,
      promisedFor: r.promised_for,
    };
    if (c.promisedFor) c.skippedReason = 'promise';
    else if (c.lastReminderAt && (Date.now() - new Date(c.lastReminderAt).getTime()) / 86_400_000 < cooldownDays) c.skippedReason = 'cooldown';
    (c.skippedReason ? skipped : eligible).push(c);
  }
  return { eligible, skipped };
}

export function defaultReminderText(c: OverdueCandidate): string {
  return `Namaste ${c.customer}, gentle reminder: invoice ${c.invoice ?? ''} of ₹${c.amount.toLocaleString('en-IN')} is ${c.overdueDays} days overdue. Kindly arrange payment at the earliest — let us know if there is any issue from our side. — Accounts`;
}

export interface BatchDraftResult {
  approvalId?: string;
  decision: string;
  count: number;
  totalAmount: number;
  messages: Array<{ invoice: string | null; customer: string; amount: number; text: string }>;
  reason: string;
}

/**
 * Batch-draft reminders for all eligible overdue invoices as ONE approval
 * item (spec: "12 reminders ready to send"). Runs fully deterministic —
 * templates, not LLM — so preview text equals sent text.
 */
export async function batchDraftReminders(
  orgId: string,
  opts: { minDaysOverdue?: number; cooldownDays?: number } = {}
): Promise<BatchDraftResult> {
  const { eligible } = await getReminderCandidates(orgId, opts.minDaysOverdue ?? 1, opts.cooldownDays ?? REMINDER_COOLDOWN_DAYS);
  const messages = eligible.map((c) => ({
    invoice: c.invoice,
    customer: c.customer,
    amount: c.amount,
    text: defaultReminderText(c),
  }));

  const preview =
    messages.length === 0
      ? 'No overdue invoices need a reminder right now.'
      : `${messages.length} reminder${messages.length > 1 ? 's' : ''} ready to send — ₹${messages.reduce((s, m) => s + m.amount, 0).toLocaleString('en-IN')} overdue. First: ${messages[0]!.customer} (${messages[0]!.invoice})`;

  const r = await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'send_reminder_batch',
      entityType: 'invoice_batch',
      payload: { messages },
      preview,
      risk: 'external',
    },
    (pl) => executeSendReminderBatch(orgId, pl as { messages: BatchDraftResult['messages'] })
  );

  return {
    approvalId: r.approvalId,
    decision: r.decision,
    count: messages.length,
    totalAmount: messages.reduce((s, m) => s + m.amount, 0),
    messages,
    reason: r.reason,
  };
}

/** Batch executor: one approval → N sends, each logged with its outcome. */
export async function executeSendReminderBatch(
  orgId: string,
  payload: { messages: BatchDraftResult['messages'] }
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  let sent = 0;
  const results: Array<{ invoice: string | null; to: string; ok: boolean }> = [];
  for (const m of payload.messages) {
    const invoiceId = (
      await query<{ id: string }>(`select id from entities where org_id=$1 and type='invoice' and code=$2 limit 1`, [orgId, m.invoice ?? ''])
    )[0]?.id;
    const res = await executeAction(orgId, 'send_reminder', {
      invoiceId,
      invoice: m.invoice,
      customerId: invoiceId
        ? (
            await query<{ party_id: string | null }>('select party_id from entities where id=$1', [invoiceId])
          )[0]?.party_id ?? undefined
        : undefined,
      customer: m.customer,
      amount: m.amount,
      channel: 'whatsapp',
      message: m.text,
    });
    if (res.ok) sent++;
    results.push({ invoice: m.invoice, to: m.customer, ok: res.ok });
  }
  return { ok: sent > 0, result: { sent, total: payload.messages.length, results } };
}

export interface PromiseToPayResult {
  ok: boolean;
  promiseId?: string;
  error?: string;
}

/**
 * Record (or update) a promise-to-pay against an invoice. Human-confirmed —
 * the webhook files it as a SUGGESTION when a customer replies with a date,
 * and an owner confirm turns it into this record.
 */
export async function recordPromiseToPay(
  orgId: string,
  input: { invoiceId: string; promiseDate: string; note?: string; via?: string }
): Promise<PromiseToPayResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.promiseDate)) {
    return { ok: false, error: 'promiseDate must be YYYY-MM-DD' };
  }
  const inv = (
    await query<{ code: string | null; party_id: string | null }>(
      'select code, party_id from entities where org_id=$1 and type=$2 and id=$3 limit 1',
      [orgId, 'invoice', input.invoiceId]
    )
  )[0];
  if (!inv) return { ok: false, error: 'invoice not found' };

  const rows = await query<{ id: string }>(
    `insert into entities (id, org_id, type, status, party_id, date, source, data)
     values (gen_random_uuid()::text, $1, 'promise_to_pay', 'pending', $2, $3, 'agent', $4::jsonb) returning id`,
    [
      orgId,
      inv.party_id,
      input.promiseDate,
      JSON.stringify({
        invoiceId: input.invoiceId,
        invoice: inv.code,
        promiseDate: input.promiseDate,
        note: input.note ?? null,
        via: input.via ?? 'web',
      }),
    ]
  );
  // trust layer: the promise lands on the activity timeline — reminders for
  // this invoice pause from here, so the owner must see why
  await recordAgentAction({
    orgId,
    actor: `user:${input.via ?? 'web'}`,
    actionType: 'promise_to_pay',
    summary: `Recorded promise-to-pay for ${inv.code ?? 'invoice'} — ${input.promiseDate}${input.note ? ` (${input.note})` : ''}. Reminders paused until then.`,
    reason: 'Owner-confirmed commitment; the collections agent honours it instead of chasing',
    sources: [{ type: 'invoice', label: `Invoice ${inv.code ?? ''}`, ref: input.invoiceId }],
    entityType: 'promise_to_pay',
    entityId: rows[0]!.id,
    status: 'executed',
    metadata: { invoiceId: input.invoiceId, promiseDate: input.promiseDate },
  });
  return { ok: true, promiseId: rows[0]!.id };
}

/**
 * Detect a promise-to-pay in a customer's inbound reply ("will pay by Friday",
 * "payment on 12th"). Returns a suggestion payload for human confirmation —
 * the caller (webhook) files it, never applies it.
 */
export function detectPromiseToPay(text: string): { date: string; confidence: 'low' | 'medium' } | null {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return { date: iso[1]!, confidence: 'medium' };
  const dmy = text.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = dmy[3] ? (Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3])) : new Date().getFullYear();
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, confidence: 'low' };
    }
  }
  return null;
}
