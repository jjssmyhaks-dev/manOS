import { query } from '@factory/db';

/**
 * Demand forecasting + lightweight MRP (PRD F5 procurement).
 *
 * forecastDemand — 4-week moving average of weekly sales-order demand per item
 *   (deterministic, explainable; no model needed at MSME volumes).
 * runMrp — material requirements planning:
 *   gross requirement = open sales orders (incl. overdue) + forecast over the
 *   remaining horizon
 *   net requirement  = gross − stock on hand (floored at 0, reorder safety kept)
 *   components       — BOM lines inherit their parent's net requirement × qty
 *                      per unit, netted against their own stock
 * Output is exactly what a purchase head needs: "raise these POs today",
 * with the arithmetic visible (why: open orders, forecast, on-hand).
 */

export interface ForecastPoint {
  itemId: string;
  item: string | null;
  uom: string | null;
  /** average weekly demand over the lookback window */
  weeklyAvg: number;
  /** projected units over the horizon (weeks × weeklyAvg) */
  projectedUnits: number;
  /** recent weekly demand history, oldest → newest (for sparklines/debug) */
  history: number[];
}

export interface MrpSuggestion {
  itemId: string;
  item: string | null;
  uom: string | null;
  kind: 'finished' | 'component';
  /** demand driver: open order qty + forecast units */
  grossReq: number;
  onHand: number;
  netReq: number;
  /** suggested order quantity (net requirement, at least 1 if positive) */
  suggestedQty: number;
  /** parent item when this demand comes from a BOM explosion */
  drivenBy?: string;
  /** explanation for the UI / agent */
  why: string;
}

export interface MrpResult {
  asOf: string;
  horizonWeeks: number;
  forecast: ForecastPoint[];
  suggestions: MrpSuggestion[];
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

/**
 * 4-week moving-average forecast per item from sales-order history.
 * Weeks with no orders count as zero demand — MSME demand is lumpy and
 * pretending otherwise causes stockouts.
 */
export async function forecastDemand(orgId: string, lookbackWeeks = 8, horizonWeeks = 4): Promise<ForecastPoint[]> {
  const rows = await query<{ item_id: string; item: string | null; uom: string | null; wk: string; qty: string }>(
    `select item_id,
            coalesce((select coalesce(name, data->>'name') from entities p where p.id = e.item_id), '(unknown)') as item,
            coalesce((select data->>'uom' from entities p where p.id = e.item_id), '') as uom,
            to_char(date_trunc('week', date), 'YYYY-MM-DD') as wk,
            sum(qty) as qty
     from entities e
     where org_id = $1 and type = 'sales_order' and status != 'cancelled'
       and date >= current_date - ($2 * 7)
     group by item_id, wk
     order by item_id, wk`,
    [orgId, lookbackWeeks]
  );

  // build complete week grid per item (zero-fill missing weeks)
  const weeks: string[] = [];
  const now = new Date();
  for (let i = lookbackWeeks - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    d.setUTCHours(0, 0, 0, 0);
    // align to Monday like date_trunc('week')
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    weeks.push(d.toISOString().slice(0, 10));
  }

  const byItem = new Map<string, { item: string | null; uom: string | null; hist: Map<string, number> }>();
  for (const r of rows) {
    let e = byItem.get(r.item_id);
    if (!e) { e = { item: r.item, uom: r.uom, hist: new Map() }; byItem.set(r.item_id, e); }
    e.hist.set(r.wk, num(r.qty));
  }

  const out: ForecastPoint[] = [];
  for (const [itemId, e] of byItem) {
    const history = weeks.map((w) => e.hist.get(w) ?? 0);
    const recent = history.slice(-4);
    const weeklyAvg = recent.reduce((s, v) => s + v, 0) / Math.max(1, recent.length);
    out.push({
      itemId,
      item: e.item,
      uom: e.uom,
      weeklyAvg: Math.round(weeklyAvg * 10) / 10,
      projectedUnits: Math.round(weeklyAvg * horizonWeeks),
      history,
    });
  }
  return out.sort((a, b) => b.projectedUnits - a.projectedUnits);
}

/**
 * Net requirements across finished items and their BOM components.
 * Deterministic and auditable — every suggestion carries its arithmetic.
 */
export async function runMrp(orgId: string, opts: { horizonWeeks?: number } = {}): Promise<MrpResult> {
  const horizonWeeks = opts.horizonWeeks ?? 4;
  const forecast = await forecastDemand(orgId, 8, horizonWeeks);

  // open demand: confirmed/in-production SOs not yet dispatched (incl. overdue)
  const openRows = await query<{ item_id: string; qty: string }>(
    `select item_id, sum(qty) as qty from entities
     where org_id = $1 and type = 'sales_order' and status in ('confirmed','in_production')
     group by item_id`,
    [orgId]
  );
  const openDemand = new Map(openRows.map((r) => [r.item_id, num(r.qty)]));

  // on-hand per item
  const stockRows = await query<{ id: string; soh: string }>(
    `select id, coalesce((data->>'stockOnHand')::numeric, 0) as soh from entities where org_id = $1 and type = 'item'`,
    [orgId]
  );
  const onHand = new Map(stockRows.map((r) => [r.id, num(r.soh)]));

  const suggestions: MrpSuggestion[] = [];

  // level 0: finished items
  for (const f of forecast) {
    const gross = (openDemand.get(f.itemId) ?? 0) + f.projectedUnits;
    const soh = onHand.get(f.itemId) ?? 0;
    const net = Math.max(0, gross - soh);
    if (net <= 0) continue;
    suggestions.push({
      itemId: f.itemId, item: f.item, uom: f.uom, kind: 'finished',
      grossReq: gross, onHand: soh, netReq: net, suggestedQty: net,
      why: `open orders ${openDemand.get(f.itemId) ?? 0} + ${horizonWeeks}-week forecast ${f.projectedUnits} − stock ${soh}`,
    });
  }

  // level 1: BOM components inherit net requirement of their parents
  // (BOM rows are entities of type 'bom' with data.parentId / data.childId /
  //  data.qtyPerUnit — JSONB keeps the schema engine-agnostic)
  const parents = suggestions.map((s) => s.itemId);
  if (parents.length) {
    const bomRows = await query<{ pid: string; cid: string; per: string; comp: string | null; uom: string | null }>(
      `select b.data->>'parentId' as pid, b.data->>'childId' as cid, b.data->>'qtyPerUnit' as per,
              coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = (b.data->>'childId')), '(unknown)') as comp,
              coalesce((select p.data->>'uom' from entities p where p.id = (b.data->>'childId')), '') as uom
       from entities b
       where b.org_id = $1 and b.type = 'bom' and b.data->>'parentId' = any($2)`,
      [orgId, parents]
    );
    for (const b of bomRows) {
      const parent = suggestions.find((s) => s.itemId === b.pid);
      if (!parent) continue;
      const gross = parent.netReq * num(b.per);
      const soh = onHand.get(b.cid) ?? 0;
      const net = Math.max(0, gross - soh);
      if (net <= 0) continue;
      suggestions.push({
        itemId: b.cid, item: b.comp, uom: b.uom, kind: 'component',
        grossReq: Math.round(gross * 100) / 100, onHand: soh, netReq: net, suggestedQty: Math.ceil(net),
        drivenBy: parent.item ?? b.pid,
        why: `${parent.item ?? 'parent'} needs ${parent.netReq} × ${num(b.per)} ${b.uom || ''} per unit − stock ${soh}`,
      });
    }
  }

  return { asOf: new Date().toISOString(), horizonWeeks, forecast, suggestions };
}
