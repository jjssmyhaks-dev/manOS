import { query } from '@factory/db';
import { runMetric } from './semantic.js';

/**
 * Proactive anomaly scans (PRD §9 dashboards→alerts): the agent should not
 * wait to be asked. Deterministic, SQL-backed checks that run in the daily
 * cron and render on the dashboard — finance-grade vigilance without an
 * analyst:
 *   1. price_variance    — invoice/PO unit price far from the item's median
 *   2. duplicate_invoice — same customer + amount within 3 days (double entry)
 *   3. receivables_spike — overdue balance far above its trailing 8-week level
 * Each finding carries severity, a human explanation and the evidence row so
 * the UI can show *why* it fired. No model in the loop: zero hallucination
 * surface, stable enough to page an owner at 2am.
 */

export type AnomalySeverity = 'high' | 'medium' | 'low';

export interface Anomaly {
  kind: 'price_variance' | 'duplicate_invoice' | 'receivables_spike';
  severity: AnomalySeverity;
  title: string;
  detail: string;
  entityType: string;
  entityId?: string;
  /** quantified signal (ratio, amount duplicated, spike %) for sorting/tests */
  metric: number;
}

export interface AnomalyReport {
  asOf: string;
  scanned: { invoices: number; purchaseOrders: number };
  anomalies: Anomaly[];
  ok: boolean;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function inr(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export const PRICE_VARIANCE_THRESHOLD = 0.5; // unit price deviates >50% from item median
export const RECEIVABLES_SPIKE_PCT = 0.4; // overdue >40% above trailing average

/** 1. Unit price far from the item's median across invoices + purchase orders. */
export async function scanPriceVariance(orgId: string): Promise<Anomaly[]> {
  // NOTE: ordered-set aggregates (percentile_cont) cannot be window functions
  // in Postgres, so medians are computed in a GROUP BY CTE and joined back.
  const rows = await query<{ id: string; type: string; code: string | null; item_id: string | null; item_name: string | null; qty: string | null; amount: string | null; median_rate: string | null }>(
    `with medians as (
       select item_id, percentile_cont(0.5) within group (order by (amount / nullif(qty, 0))) as median_rate
       from entities
       where org_id = $1 and type in ('invoice', 'purchase_order') and qty > 0 and amount > 0
       group by item_id
     )
     select e.id, e.type, e.code, e.item_id,
            coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.item_id), '(unknown item)') as item_name,
            e.qty, e.amount, m.median_rate
     from entities e
     join medians m on m.item_id = e.item_id
     where e.org_id = $1 and e.type in ('invoice', 'purchase_order') and e.qty > 0 and e.amount > 0`,
    [orgId]
  );

  const out: Anomaly[] = [];
  for (const r of rows) {
    const unit = num(r.amount) / num(r.qty);
    const median = num(r.median_rate);
    if (median <= 0) continue;
    const dev = Math.abs(unit - median) / median;
    if (dev <= PRICE_VARIANCE_THRESHOLD) continue;
    out.push({
      kind: 'price_variance',
      severity: dev > 1 ? 'high' : 'medium',
      title: `${r.code ?? r.type} — ${r.item_name} priced ${Math.round(dev * 100)}% off normal`,
      detail: `Unit price ${inr(unit)} vs usual ${inr(median)} (${r.type === 'invoice' ? 'billed to customer' : 'paid to vendor'}). Worth a check before it repeats.`,
      entityType: r.type,
      entityId: r.id,
      metric: dev,
    });
  }
  return out.sort((a, b) => b.metric - a.metric).slice(0, 10);
}

/** 2. Possible duplicate invoices: same customer + same amount within 3 days. */
export async function scanDuplicateInvoices(orgId: string): Promise<Anomaly[]> {
  const rows = await query<{ a_id: string; b_id: string; a_code: string | null; b_code: string | null; party_id: string | null; amount: string; day_gap: string }>(
    `select a.id as a_id, b.id as b_id, a.code as a_code, b.code as b_code, a.party_id, a.amount,
            abs(a.date - b.date) as day_gap
     from entities a
     join entities b
       on a.org_id = b.org_id
      and a.id < b.id
      and a.party_id = b.party_id
      and a.amount = b.amount
      and abs(a.date - b.date) <= 3
     where a.org_id = $1 and a.type = 'invoice' and b.type = 'invoice'
       and a.status not in ('cancelled') and b.status not in ('cancelled')`,
    [orgId]
  );

  const out: Anomaly[] = [];
  for (const r of rows) {
    out.push({
      kind: 'duplicate_invoice',
      severity: 'high',
      title: `Possible duplicate: ${r.a_code ?? '?'} and ${r.b_code ?? '?'} for ${inr(num(r.amount))}`,
      detail: `Same customer, same amount, ${r.day_gap} day(s) apart — check for a double entry or a genuine repeat order.`,
      entityType: 'invoice',
      entityId: r.a_id,
      metric: num(r.amount),
    });
  }
  return out;
}

/** 3. Overdue receivables far above their trailing weekly level. */
export async function scanReceivablesSpike(orgId: string): Promise<Anomaly[]> {
  const cur = await runMetric(orgId, 'overdue_total');
  const current = num(cur.value);
  if (current <= 0) return [];

  // weekly overdue snapshots for the trailing 8 weeks (from audit trail of
  // metric runs is unreliable — approximate from invoices that were already
  // overdue at each past week)
  const rows = await query<{ wk: string; total: string | null }>(
    `select to_char(week_start, 'YYYY-MM-DD') as wk, sum(
       case when (data->>'dueDate')::date < week_start
            and coalesce(data->>'paid', 'false')::boolean = false
         then amount else 0 end) as total
     from entities,
       (select generate_series(current_date - interval '8 weeks', current_date - interval '1 week', interval '1 week')::date as week_start) w
     where org_id = $1 and type = 'invoice' and status in ('sent','overdue','partial')
     group by week_start order by week_start`,
    [orgId]
  );
  const history = rows.map((r) => num(r.total)).filter((v) => v > 0);
  if (history.length < 4) return []; // not enough history to judge a spike

  const avg = history.reduce((s, v) => s + v, 0) / history.length;
  if (avg <= 0) return [];
  const spike = (current - avg) / avg;
  if (spike <= RECEIVABLES_SPIKE_PCT) return [];

  return [{
    kind: 'receivables_spike',
    severity: spike > 1 ? 'high' : 'medium',
    title: `Overdue receivables up ${Math.round(spike * 100)}% vs the last 8 weeks`,
    detail: `Overdue now ${inr(current)} vs ${inr(avg)} typical. Collection focus today pays more than any new order.`,
    entityType: 'metric',
    metric: spike,
  }];
}

/** Run all scans for an org. */
export async function scanAnomalies(orgId: string): Promise<AnomalyReport> {
  const [price, dupes, spike] = await Promise.all([
    scanPriceVariance(orgId),
    scanDuplicateInvoices(orgId),
    scanReceivablesSpike(orgId),
  ]);
  const counts = await query<{ inv: string; po: string }>(
    `select count(*) filter (where type='invoice') as inv, count(*) filter (where type='purchase_order') as po from entities where org_id=$1`,
    [orgId]
  );
  const anomalies = [...spike, ...dupes, ...price];
  return {
    asOf: new Date().toISOString(),
    scanned: { invoices: num(counts[0]?.inv), purchaseOrders: num(counts[0]?.po) },
    anomalies,
    ok: anomalies.length === 0,
  };
}

/** Human-readable alert block for the digest / WhatsApp. */
export function anomalyLines(report: AnomalyReport, max = 5): string[] {
  if (report.anomalies.length === 0) return ['No anomalies detected.'];
  return report.anomalies.slice(0, max).map((a) => `${a.severity === 'high' ? '🔴' : '🟡'} ${a.title}`);
}
