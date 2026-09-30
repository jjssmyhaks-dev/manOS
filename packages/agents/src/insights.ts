import { query } from '@factory/db';

/**
 * Predictive layer — deterministic, explainable, SQL-backed (no black box):
 *
 * 1. Delivery-delay risk for open sales orders: each open order is scored
 *    from how far past its due date it already is, whether its item has
 *    blocked job cards, and that item's average machine downtime. Every
 *    score carries its reasons, so the answer is auditable.
 * 2. Cash-collection forecast: open invoices bucketed by expected payment
 *    week from due dates + each customer's historical pay-in behaviour,
 *    so "how much cash lands in the next 4 weeks?" has a real answer.
 */

export interface DelayRisk {
  orderCode: string | null;
  customer: string | null;
  item: string | null;
  qty: number;
  dueDate: string | null;
  daysOverdue: number;
  risk: 'high' | 'medium' | 'low';
  score: number;
  reasons: string[];
}

export interface DelayRiskReport {
  asOf: string;
  orders: DelayRisk[];
  atRisk: number;
}

export interface CashWeek {
  weekStart: string;
  expected: number;
  invoices: number;
}

export interface CashForecastReport {
  asOf: string;
  totalExpected: number;
  weeks: CashWeek[];
  assumptions: string[];
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function inr(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function mondayOn(d: Date): Date {
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const m = new Date(d);
  m.setUTCDate(m.getUTCDate() - diff);
  m.setUTCHours(0, 0, 0, 0);
  return m;
}

/** 1. Score every open sales order for delivery-delay risk with reasons. */
export async function predictDeliveryDelays(orgId: string): Promise<DelayRiskReport> {
  const rows = await query<{
    id: string;
    code: string | null;
    qty: string | null;
    item_id: string | null;
    party_id: string | null;
    status: string | null;
    due: string | null;
    customer: string | null;
    item_name: string | null;
    blocked: string | null;
    avg_downtime: string | null;
  }>(
    `with item_stats as (
       select item_id,
              count(*) filter (where status = 'blocked') as blocked,
              avg((data->>'downtimeMins')::numeric) as avg_downtime
       from entities
       where org_id = $1 and type = 'job_card' and item_id is not null
       group by item_id
     )
     select e.id, e.code, e.qty, e.item_id, e.party_id, e.status,
            coalesce(e.data->>'dueDate', e.data->>'deliveryDate') as due,
            coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), '(unknown)') as customer,
            coalesce((select coalesce(i.name, i.data->>'name') from entities i where i.id = e.item_id), '(unknown item)') as item_name,
            s.blocked, s.avg_downtime
     from entities e
     left join item_stats s on s.item_id = e.item_id
     where e.org_id = $1 and e.type = 'sales_order'
       and e.status in ('confirmed', 'in_production')
     order by e.date desc
     limit 60`,
    [orgId]
  );

  const today = new Date();
  const orders: DelayRisk[] = [];
  for (const r of rows) {
    const due = r.due ? new Date(r.due) : null;
    const daysOverdue = due ? Math.floor((today.getTime() - due.getTime()) / 86400000) : 0;
    const reasons: string[] = [];
    let score = 0;

    if (daysOverdue > 0) {
      score += Math.min(50, daysOverdue * 2);
      reasons.push(`${daysOverdue}d past due date`);
    }
    const blocked = num(r.blocked);
    if (blocked > 0) {
      score += 25;
      reasons.push(`${blocked} blocked job card${blocked > 1 ? 's' : ''} on this item`);
    }
    const downtime = num(r.avg_downtime);
    if (downtime > 45) {
      score += 15;
      reasons.push(`${Math.round(downtime)} min avg machine downtime`);
    }
    if (r.status === 'in_production') {
      score += 10;
      reasons.push('still in production');
    }

    const risk: DelayRisk['risk'] = score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
    orders.push({
      orderCode: r.code,
      customer: r.customer,
      item: r.item_name,
      qty: num(r.qty),
      dueDate: r.due,
      daysOverdue,
      risk,
      score,
      reasons,
    });
  }

  orders.sort((a, b) => b.score - a.score);
  return {
    asOf: new Date().toISOString(),
    orders,
    atRisk: orders.filter((o) => o.risk !== 'low').length,
  };
}

/** 2. Forecast cash collections over the next horizon from invoice dues + pay behaviour. */
export async function forecastCash(
  orgId: string,
  horizonWeeks = 4
): Promise<CashForecastReport> {
  const open = await query<{ id: string; amount: string | null; party_id: string | null; due: string | null; customer: string | null; paid_days_late: string | null }>(
    `select e.id, e.amount, e.party_id, e.data->>'dueDate' as due,
            coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), '(unknown)') as customer,
            avg_case.avg_late
     from entities e
     left join (
       select party_id,
              avg(greatest(0, (data->>'paidOn')::date - (data->>'dueDate')::date)) as avg_late
       from entities
       where org_id = $1 and type = 'invoice' and data->>'paidOn' is not null
       group by party_id
     ) avg_case on avg_case.party_id = e.party_id
     where e.org_id = $1 and e.type = 'invoice'
       and e.status in ('sent', 'overdue', 'partial')
       and e.data->>'dueDate' is not null`,
    [orgId]
  );

  const today = new Date();
  const weeks: CashWeek[] = [];
  const start = mondayOn(today);
  for (let i = 0; i < horizonWeeks; i++) {
    const ws = new Date(start);
    ws.setUTCDate(ws.getUTCDate() + i * 7);
    weeks.push({ weekStart: ws.toISOString().slice(0, 10), expected: 0, invoices: 0 });
  }

  const assumptions: string[] = [];
  for (const inv of open) {
    const due = inv.due ? new Date(inv.due) : null;
    if (!due) continue;
    const late = inv.paid_days_late != null ? num(inv.paid_days_late) : 7; // default assumption: a week late
    const expected = new Date(due.getTime() + late * 86400000);
    const idx = Math.floor((mondayOn(expected).getTime() - start.getTime()) / (7 * 86400000));
    const bucket = idx < 0 ? 0 : idx >= horizonWeeks ? horizonWeeks - 1 : idx;
    if (idx < 0) assumptions.push(`${inv.customer}: already overdue — expected this week`);
    if (idx >= horizonWeeks) assumptions.push(`${inv.customer}: expected beyond horizon (${expected.toISOString().slice(0, 10)})`);
    weeks[bucket]!.expected += num(inv.amount);
    weeks[bucket]!.invoices += 1;
  }
  if (!open.some((o) => o.paid_days_late != null)) {
    assumptions.push('No payment history yet — assuming invoices land 7 days after due date');
  }

  return {
    asOf: new Date().toISOString(),
    totalExpected: weeks.reduce((s, w) => s + w.expected, 0),
    weeks,
    assumptions: [...new Set(assumptions)].slice(0, 6),
  };
}

/** One-line human summaries used by the digest. */
export function delayRiskLines(report: DelayRiskReport, max = 4): string[] {
  return report.orders
    .filter((o) => o.risk !== 'low')
    .slice(0, max)
    .map((o) => `• ${o.orderCode ?? '?'} (${o.customer ?? '?'}, ${o.item ?? '?'}): ${o.risk} risk — ${o.reasons.join('; ')}`);
}

export function cashForecastLines(report: CashForecastReport): string[] {
  return [
    `Expected collections next ${report.weeks.length} weeks: ${inr(report.totalExpected)}`,
    ...report.weeks.map((w) => `• week of ${w.weekStart}: ${inr(w.expected)} (${w.invoices} invoice${w.invoices === 1 ? '' : 's'})`),
  ];
}
