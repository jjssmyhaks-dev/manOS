import { tool } from 'ai';
import { z } from 'zod';
import { query, listEntities } from '@factory/db';
import { runMetric, listMetrics } from '../semantic.js';

export interface AgentContext {
  orgId: string;
  role: string;
  conversationId?: string;
}

/** Risk tags are re-declared here for the guardrail layer and UI badges. */
export const TOOL_RISK: Record<string, 'read' | 'write' | 'external'> = {
  query_data: 'read',
  list_overdue: 'read',
  get_item_stock: 'read',
  sales_summary: 'read',
  reorder_check: 'read',
  explain_metric: 'read',
  draft_reminders: 'write',
  draft_rfq: 'write',
  create_po_draft: 'write',
  log_shift_output: 'write',
  expiry_report: 'read',
  yield_report: 'read',
  fx_exposure: 'read',
  export_docs_status: 'read',
};

// --- query_data: named metric execution -------------------------------------

export const queryDataTool = (ctx: AgentContext) =>
  tool({
    description:
      'Run a named business metric over this factory\'s data. Always use this for numbers; never compute figures yourself. Available metric keys are provided in the system prompt.',
    inputSchema: z.object({
      metricKey: z.string().describe('Metric key from the provided metric list'),
      params: z.record(z.unknown()).optional(),
    }),
    execute: async ({ metricKey, params }) => {
      const result = await runMetric(ctx.orgId, metricKey, params ?? {});
      return { metric: metricKey, ...result };
    },
  });

// --- list_overdue ------------------------------------------------------------

export const listOverdueTool = (ctx: AgentContext) =>
  tool({
    description: 'List overdue customer invoices with amounts, days overdue and ageing buckets.',
    inputSchema: z.object({
      minDaysOverdue: z.number().int().min(0).max(365).optional().describe('Filter: only invoices overdue at least this many days'),
    }),
    execute: async ({ minDaysOverdue }) => {
      const res = await runMetric(ctx.orgId, 'overdue_total');
      const lines = (res.breakdown as { lines: Array<{ customer: string | null; invoice: string | null; amount: number; overdueDays: number }> } | undefined)?.lines ?? [];
      const filtered = lines.filter((l) => l.overdueDays >= (minDaysOverdue ?? 0));
      return {
        total: filtered.reduce((s, l) => s + l.amount, 0),
        count: filtered.length,
        invoices: filtered.sort((a, b) => b.overdueDays - a.overdueDays),
        asOf: res.asOf,
      };
    },
  });

// --- get_item_stock -----------------------------------------------------------

export const getItemStockTool = (ctx: AgentContext) =>
  tool({
    description: 'Get stock on hand, reorder point and recent ledger movement for an item by name.',
    inputSchema: z.object({ itemName: z.string().describe('Item name or code (fuzzy match)') }),
    execute: async ({ itemName }) => {
      const rows = await query<{ id: string; data: Record<string, unknown> }>(
        `select id, data from entities
         where org_id=$1 and type='item' and (data->>'name' ilike $2 or data->>'code' ilike $2)
         limit 5`,
        [ctx.orgId, `%${itemName}%`]
      );
      const out = [];
      for (const r of rows) {
        const d = r.data as { name?: string; stockOnHand?: number; reorderPoint?: number; reorderQty?: number; uom?: string; stdRate?: number };
        const moves = await query<{ qty: string; date: string; kind: string }>(
          `select qty, date::text, data->>'kind' as kind from entities
           where org_id=$1 and type='stock_ledger' and item_id=$2 order by date desc limit 8`,
          [ctx.orgId, r.id]
        );
        out.push({
          itemId: r.id, name: d.name, stockOnHand: d.stockOnHand ?? 0, reorderPoint: d.reorderPoint,
          suggestedReorderQty: d.reorderQty, uom: d.uom, stdRate: d.stdRate,
          low: (d.stockOnHand ?? 0) <= (d.reorderPoint ?? 0),
          recentMovements: moves.map((m) => ({ qty: Number(m.qty), date: m.date, kind: m.kind })),
        });
      }
      return { matches: out.length, items: out };
    },
  });

// --- sales_summary --------------------------------------------------------------

export const salesSummaryTool = (ctx: AgentContext) =>
  tool({
    description: 'Sales overview for a recent window: total, order count, top customers, status mix.',
    inputSchema: z.object({
      days: z.number().int().min(1).max(365).optional().describe('Window length in days (default 30)'),
    }),
    execute: async ({ days }) => {
      const d = days ?? 30;
      const totals = await query<{ total: string | null; n: string }>(
        `select sum(amount) as total, count(*) as n from entities
         where org_id=$1 and type='sales_order' and date >= current_date - $2 and status != 'cancelled'`,
        [ctx.orgId, d]
      );
      const byStatus = await query<{ status: string | null; n: string; amt: string }>(
        `select status, count(*) as n, sum(amount) as amt from entities
         where org_id=$1 and type='sales_order' and date >= current_date - $2 group by status order by sum(amount) desc`,
        [ctx.orgId, d]
      );
      const top = await runMetric(ctx.orgId, 'sales_by_customer_30d');
      return {
        windowDays: d,
        totalSales: Number(totals[0]?.total ?? 0),
        orderCount: Number(totals[0]?.n ?? 0),
        byStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.n), amount: Number(r.amt) })),
        topCustomers: top.breakdown ?? [],
        asOf: top.asOf,
      };
    },
  });

// --- reorder_check ----------------------------------------------------------------

export const reorderCheckTool = (ctx: AgentContext) =>
  tool({
    description: 'Items at/below reorder point with suggested quantities and preferred vendor info for drafting RFQs.',
    inputSchema: z.object({}),
    execute: async () => {
      const res = await runMetric(ctx.orgId, 'low_stock_items');
      const items = (res.breakdown ?? []) as Array<{ itemId: string; item: string | null; stockOnHand: number; reorderPoint: number; suggestedQty: number; uom: string | null }>;
      // preferred vendors per category from org facts + party preferred flags
      const vendors = await query<{ id: string; name: string | null; pref: boolean }>(
        `select id, data->>'name' as name, coalesce((data->>'preferred')::boolean, false) as pref
         from entities where org_id=$1 and type='party' and data->>'kind'='vendor'`,
        [ctx.orgId]
      );
      return {
        items,
        vendors: vendors.map((v) => ({ vendorId: v.id, name: v.name, preferred: v.pref })),
        asOf: res.asOf,
      };
    },
  });

// --- pack-specific reads ------------------------------------------------------------

export const expiryReportTool = (ctx: AgentContext) =>
  tool({
    description: 'FMCG: stock expiring within N days by batch.',
    inputSchema: z.object({ withinDays: z.number().int().min(1).max(365).optional() }),
    execute: async ({ withinDays }) => {
      const rows = await query<{ name: string | null; batch: string | null; exp: string | null; qty: string | null }>(
        `select data->>'name' as name, data->>'batchNo' as batch, data->>'expiryDate' as exp, qty
         from entities where org_id=$1 and type='stock_ledger' and data->>'expiryDate' is not null
           and (data->>'expiryDate')::date <= current_date + $2
         order by (data->>'expiryDate')::date asc limit 50`,
        [ctx.orgId, withinDays ?? 60]
      );
      return { items: rows, asOf: new Date().toISOString().slice(0, 10) };
    },
  });

export const yieldReportTool = (ctx: AgentContext) =>
  tool({
    description: 'Scrap: input vs output weight yield from weighbridge tickets.',
    inputSchema: z.object({ days: z.number().int().min(1).max(180).optional() }),
    execute: async ({ days }) => {
      const rows = await query<{ gross: string | null; tare: string | null; grade: string | null; date: string }>(
        `select (data->>'grossKg') as gross, (data->>'tareKg') as tare, (data->>'grade') as grade, date::text
         from entities where org_id=$1 and type='weighbridge_ticket' and date >= current_date - $2`,
        [ctx.orgId, days ?? 30]
      );
      const inKg = rows.reduce((s, r) => s + Number(r.gross ?? 0) - Number(r.tare ?? 0), 0);
      return { inputKg: inKg, tickets: rows.length, asOf: new Date().toISOString().slice(0, 10) };
    },
  });

export const fxExposureTool = (ctx: AgentContext) =>
  tool({
    description: 'Exports: open FX exposure on unpaid export invoices.',
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await query<{ amount: string | null; ccy: string | null; fx: string | null }>(
        `select amount, data->>'currency' as ccy, (data->>'fxRate') as fx
         from entities where org_id=$1 and type='invoice' and status in ('sent','overdue') and data->>'currency' is not null`,
        [ctx.orgId]
      );
      const byCcy: Record<string, number> = {};
      for (const r of rows) {
        const c = r.ccy ?? 'USD';
        byCcy[c] = (byCcy[c] ?? 0) + Number(r.amount ?? 0);
      }
      return { exposure: byCcy, invoices: rows.length, asOf: new Date().toISOString().slice(0, 10) };
    },
  });

export const exportDocsStatusTool = (ctx: AgentContext) =>
  tool({
    description: 'Exports: shipment document readiness (commercial invoice, packing list, LUT/IEC).',
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await query<{ code: string | null; docs: unknown }>(
        `select code, data->>'docs' as docs from entities
         where org_id=$1 and type='shipment' order by created_at desc limit 20`,
        [ctx.orgId]
      );
      return { shipments: rows, asOf: new Date().toISOString().slice(0, 10) };
    },
  });

export function readToolDefs(ctx: AgentContext) {
  return {
    query_data: queryDataTool(ctx),
    list_overdue: listOverdueTool(ctx),
    get_item_stock: getItemStockTool(ctx),
    sales_summary: salesSummaryTool(ctx),
    reorder_check: reorderCheckTool(ctx),
    expiry_report: expiryReportTool(ctx),
    yield_report: yieldReportTool(ctx),
    fx_exposure: fxExposureTool(ctx),
    export_docs_status: exportDocsStatusTool(ctx),
  };
}

export function listMetricKeysForPrompt(): string {
  return listMetrics().map((m) => `- ${m.key}: ${m.description}`).join('\n');
}

export { listEntities };
