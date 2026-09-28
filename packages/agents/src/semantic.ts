import { query } from '@factory/db';

/**
 * Semantic layer (PRD §6): named metric and dimension definitions so the
 * agent generates safe, parameterised SQL instead of free-form queries.
 * The LLM never writes numbers from memory — it selects a named metric and
 * the deterministic layer computes it.
 */

export interface MetricDef {
  key: string;
  label: string;
  description: string;
  /** Returns { value, unit, breakdown } rows. */
  compute(orgId: string, params: Record<string, unknown>): Promise<MetricResult>;
}

export interface MetricResult {
  value: number | null;
  unit: string;
  asOf: string;
  breakdown?: Array<Record<string, unknown>>;
  sql?: string;
}

const TODAY = () => new Date().toISOString().slice(0, 10);

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

export const METRICS: Record<string, MetricDef> = {
  sales_last_30d: {
    key: 'sales_last_30d',
    label: 'Sales (last 30 days)',
    description: 'Total value of sales orders dated in the last 30 days.',
    compute: async (orgId) => {
      const rows = await query<{ total: string | null }>(
        `select sum(amount) as total from entities
         where org_id=$1 and type='sales_order' and date >= current_date - 30 and status != 'cancelled'`,
        [orgId]
      );
      return { value: num(rows[0]?.total), unit: 'INR', asOf: TODAY(), sql: 'sum(sales_order.amount where date >= today-30)' };
    },
  },
  sales_by_customer_30d: {
    key: 'sales_by_customer_30d',
    label: 'Sales by customer (30 days)',
    description: 'Sales order value grouped by customer, last 30 days.',
    compute: async (orgId) => {
      const rows = await query<{ party_id: string | null; total: string }>(
        `select party_id, sum(amount) as total from entities
         where org_id=$1 and type='sales_order' and date >= current_date - 30 and status != 'cancelled'
         group by party_id order by sum(amount) desc limit 25`,
        [orgId]
      );
      const ids = rows.map((r) => r.party_id).filter(Boolean) as string[];
      const parties = ids.length
        ? await query<{ id: string; name: string }>(`select id, coalesce(name, data->>'name') as name from entities where org_id=$1 and id = any($2)`, [orgId, ids])
        : [];
      const names = new Map(parties.map((p) => [p.id, p.name]));
      return {
        value: rows.reduce((s, r) => s + num(r.total), 0),
        unit: 'INR',
        asOf: TODAY(),
        breakdown: rows.map((r) => ({ customer: names.get(r.party_id ?? '') ?? r.party_id ?? 'unknown', total: num(r.total) })),
      };
    },
  },
  receivables_total: {
    key: 'receivables_total',
    label: 'Total receivables',
    description: 'Sum of unpaid/overdue invoice amounts.',
    compute: async (orgId) => {
      const rows = await query<{ total: string | null }>(
        `select sum(amount) as total from entities
         where org_id=$1 and type='invoice' and status in ('sent','overdue','partial')`,
        [orgId]
      );
      return { value: num(rows[0]?.total), unit: 'INR', asOf: TODAY(), sql: "sum(invoice.amount where status in (sent,overdue,partial))" };
    },
  },
  overdue_total: {
    key: 'overdue_total',
    label: 'Overdue receivables',
    description: 'Unpaid invoices past their due date, with ageing buckets.',
    compute: async (orgId) => {
      const rows = await query<{ party_id: string | null; code: string | null; amount: string; overdue_days: string }>(
        `select party_id, code, amount,
                (current_date - (data->>'dueDate')::date) as overdue_days
         from entities
         where org_id=$1 and type='invoice' and status in ('sent','overdue','partial')
           and data->>'dueDate' is not null
           and (data->>'dueDate')::date < current_date
         order by (data->>'dueDate')::date asc`,
        [orgId]
      );
      const ids = [...new Set(rows.map((r) => r.party_id).filter(Boolean) as string[])];
      const parties = ids.length
        ? await query<{ id: string; name: string }>(`select id, coalesce(name, data->>'name') as name from entities where org_id=$1 and id = any($2)`, [orgId, ids])
        : [];
      const names = new Map(parties.map((p) => [p.id, p.name]));
      const buckets = { d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
      let total = 0;
      const lines = rows.map((r) => {
        const days = num(r.overdue_days);
        const amt = num(r.amount);
        total += amt;
        if (days <= 30) buckets.d1_30 += amt;
        else if (days <= 60) buckets.d31_60 += amt;
        else if (days <= 90) buckets.d61_90 += amt;
        else buckets.d90plus += amt;
        return { invoice: r.code, customer: names.get(r.party_id ?? '') ?? r.party_id, amount: amt, overdueDays: days };
      });
      return { value: total, unit: 'INR', asOf: TODAY(), breakdown: { buckets, lines } as unknown as Array<Record<string, unknown>>, sql: 'overdue invoices by dueDate' };
    },
  },
  stock_value: {
    key: 'stock_value',
    label: 'Stock value',
    description: 'Value of stock on hand across items.',
    compute: async (orgId) => {
      const rows = await query<{ name: string | null; soh: string; rate: string | null }>(
        `select data->>'name' as name, (data->>'stockOnHand') as soh, (data->>'stdRate') as rate
         from entities where org_id=$1 and type='item'`,
        [orgId]
      );
      let total = 0;
      const breakdown = rows.map((r) => {
        const v = num(r.soh) * num(r.rate);
        total += v;
        return { item: r.name, qty: num(r.soh), rate: num(r.rate), value: v };
      });
      return { value: total, unit: 'INR', asOf: TODAY(), breakdown, sql: 'sum(item.stockOnHand * item.stdRate)' };
    },
  },
  low_stock_items: {
    key: 'low_stock_items',
    label: 'Low stock items',
    description: 'Items at or below reorder point with suggested reorder qty.',
    compute: async (orgId) => {
      const rows = await query<{ id: string; name: string | null; soh: string; rop: string; rq: string; uom: string | null }>(
        `select id, data->>'name' as name, (data->>'stockOnHand') as soh,
                (data->>'reorderPoint') as rop, (data->>'reorderQty') as rq, (data->>'uom') as uom
         from entities where org_id=$1 and type='item' and (data->>'stockOnHand')::numeric <= (data->>'reorderPoint')::numeric`,
        [orgId]
      );
      return {
        value: rows.length,
        unit: 'items',
        asOf: TODAY(),
        breakdown: rows.map((r) => ({
          itemId: r.id, item: r.name, stockOnHand: num(r.soh), reorderPoint: num(r.rop),
          suggestedQty: num(r.rq), uom: r.uom,
        })),
        sql: 'items where stockOnHand <= reorderPoint',
      };
    },
  },
  top_delayed_orders: {
    key: 'top_delayed_orders',
    label: 'Delayed orders',
    description: 'Open sales orders past their delivery date.',
    compute: async (orgId) => {
      const rows = await query<{ id: string; code: string | null; party_id: string | null; qty: string }>(
        `select id, code, party_id, qty from entities
         where org_id=$1 and type='sales_order' and status in ('confirmed','in_production')
           and data->>'deliveryDate' is not null and (data->>'deliveryDate')::date < current_date
         order by (data->>'deliveryDate')::date asc limit 20`,
        [orgId]
      );
      const ids = [...new Set(rows.map((r) => r.party_id).filter(Boolean) as string[])];
      const parties = ids.length
        ? await query<{ id: string; name: string }>(`select id, coalesce(name, data->>'name') as name from entities where org_id=$1 and id = any($2)`, [orgId, ids])
        : [];
      const names = new Map(parties.map((p) => [p.id, p.name]));
      return {
        value: rows.length,
        unit: 'orders',
        asOf: TODAY(),
        breakdown: rows.map((r) => ({ orderId: r.id, order: r.code, customer: names.get(r.party_id ?? '') ?? r.party_id, qty: num(r.qty) })),
        sql: 'open SOs past deliveryDate',
      };
    },
  },
  open_job_cards: {
    key: 'open_job_cards',
    label: 'Open job cards',
    description: 'Job cards not yet done, grouped by status and machine.',
    compute: async (orgId) => {
      const rows = await query<{ status: string | null; machine: string | null; c: string }>(
        `select status, data->>'machine' as machine, count(*) as c from entities
         where org_id=$1 and type='job_card' and status != 'done' group by status, data->>'machine' order by count(*) desc`,
        [orgId]
      );
      return {
        value: rows.reduce((s, r) => s + num(r.c), 0),
        unit: 'jobs',
        asOf: TODAY(),
        breakdown: rows.map((r) => ({ status: r.status, machine: r.machine, count: num(r.c) })),
        sql: 'job_card group by status, machine',
      };
    },
  },
  cash_position: {
    key: 'cash_position',
    label: 'Cash collected (30d)',
    description: 'Payments received in the last 30 days.',
    compute: async (orgId) => {
      const rows = await query<{ total: string | null }>(
        `select sum(amount) as total from entities where org_id=$1 and type='payment' and date >= current_date - 30`,
        [orgId]
      );
      return { value: num(rows[0]?.total), unit: 'INR', asOf: TODAY(), sql: 'sum(payment.amount last 30d)' };
    },
  },
};

export function listMetrics(): Array<{ key: string; label: string; description: string }> {
  return Object.values(METRICS).map((m) => ({ key: m.key, label: m.label, description: m.description }));
}

export async function runMetric(orgId: string, key: string, params: Record<string, unknown> = {}): Promise<MetricResult> {
  const metric = METRICS[key];
  if (!metric) throw new Error(`Unknown metric '${key}'. Available: ${Object.keys(METRICS).join(', ')}`);
  return metric.compute(orgId, params);
}
