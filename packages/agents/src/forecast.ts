import { z } from 'zod';
import { query, audit } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { executeAction } from './tools/write.js';
import { forecastDemand, type ForecastPoint } from './mrp.js';

/**
 * Agent 11 — Demand Forecasting (spec): the forecast itself already existed
 * (mrp.ts — deterministic 4-week moving average, weeks with no orders count
 * as zero). This module completes the agent: per-item suggestions comparing
 * forecast to the current min/max settings, insufficient-history items
 * flagged instead of force-forecast (spec edge case), seasonal items marked
 * for seasonal-aware handling, and the WRITE half — a batched approvals item
 * ("adjust reorder points for N items") that updates item reorderPoint /
 * reorderQty on approval, feeding Agent 5's reorder checks downstream.
 */

export interface ReorderSuggestion {
  itemId: string;
  item: string | null;
  uom: string | null;
  currentReorderPoint: number | null;
  suggestedReorderPoint: number;
  weeklyAvg: number;
  projectedUnits: number;
  /** why the suggestion looks like this (shown in the approval preview) */
  why: string;
  caution: string | null;
}

export interface ForecastAdjustmentReport {
  asOf: string;
  suggestions: ReorderSuggestion[];
  insufficientHistory: string[];
  seasonal: string[];
  approvalId?: string;
  decision?: string;
  /** A11: snapshots persisted this cycle (for accuracy scoring later) */
  snapshotsSaved?: number;
}

/** Heuristic: coefficient of variation of weekly demand above this = seasonal/lumpy. */
const SEASONAL_CV = 0.9;
/** Weeks of history required before a forecast is trusted. */
const MIN_HISTORY_WEEKS = 6;

export async function suggestReorderAdjustments(orgId: string, horizonWeeks = 4): Promise<ForecastAdjustmentReport> {
  const forecast = await forecastDemand(orgId, 12, horizonWeeks);
  const insufficientHistory: string[] = [];
  const seasonal: string[] = [];
  const suggestions: ReorderSuggestion[] = [];

  for (const f of forecast) {
    const weeks = f.history.length;
    const mean = f.history.reduce((s, v) => s + v, 0) / Math.max(1, weeks);
    const sd = Math.sqrt(f.history.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, weeks));
    const cv = mean > 0 ? sd / mean : 0;

    if (weeks < MIN_HISTORY_WEEKS) {
      insufficientHistory.push(`${f.item ?? f.itemId} (${weeks}wk history) — set a manual starting point, no forecast`);
      continue;
    }
    if (cv > SEASONAL_CV) seasonal.push(`${f.item ?? f.itemId} — demand CV ${cv.toFixed(1)}; review with a seasonal view, suggestion is conservative`);

    // suggested reorder point = projected horizon demand + one week of safety
    const suggested = Math.max(1, Math.ceil(f.projectedUnits + f.weeklyAvg));
    const cur = (
      await query<{ rop: string | null; soh: string | null }>(
        `select data->>'reorderPoint' as rop, data->>'stockOnHand' as soh from entities where id = $1`,
        [f.itemId]
      )
    )[0];
    const currentRop = cur?.rop != null ? Number(cur.rop) : null;
    if (currentRop != null && Math.abs(currentRop - suggested) <= Math.max(1, Math.ceil(suggested * 0.1))) {
      continue; // within 10% — no churn
    }
    suggestions.push({
      itemId: f.itemId,
      item: f.item,
      uom: f.uom,
      currentReorderPoint: currentRop,
      suggestedReorderPoint: suggested,
      weeklyAvg: Math.round(f.weeklyAvg * 10) / 10,
      projectedUnits: f.projectedUnits,
      why: `${f.weeklyAvg.toFixed(1)}/wk recent demand → ${f.projectedUnits} units over ${horizonWeeks}w; ROP = horizon + 1wk safety`,
      caution: cv > SEASONAL_CV ? 'demand is lumpy/seasonal — treat as a floor' : null,
    });
  }

  return { asOf: new Date().toISOString(), suggestions, insufficientHistory, seasonal };
}

const UpdateSchema = z.object({
  updates: z
    .array(
      z.object({
        itemId: z.string(),
        reorderPoint: z.number().int().positive(),
        reorderQty: z.number().int().positive().optional(),
      })
    )
    .min(1)
    .max(50),
});

/** The WRITE half: batched approval → item min/max updated on approval. */
export async function proposeReorderPointUpdates(
  orgId: string,
  suggestions: ReorderSuggestion[]
): Promise<{ decision: string; approvalId?: string; count: number; reason: string }> {
  const parsed = UpdateSchema.safeParse({
    updates: suggestions.map((s) => ({ itemId: s.itemId, item: s.item ?? undefined, from: s.currentReorderPoint ?? undefined, reorderPoint: s.suggestedReorderPoint })),
  });
  if (!parsed.success) {
    return { decision: 'skipped', count: 0, reason: 'no valid suggestions to apply' };
  }
  const preview = `Adjust reorder points for ${parsed.data.updates.length} item${parsed.data.updates.length > 1 ? 's' : ''} based on demand trend — e.g. ${suggestions[0]!.item ?? 'item'}: ${suggestions[0]!.currentReorderPoint ?? '–'} → ${suggestions[0]!.suggestedReorderPoint}`;
  const r = await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'update_reorder_points',
      entityType: 'item_batch',
      payload: parsed.data,
      preview,
      risk: 'write',
    },
    (pl) => executeUpdateReorderPoints(orgId, pl as { updates: Array<{ itemId: string; reorderPoint: number; reorderQty?: number }> })
  );
  return { decision: r.decision, approvalId: r.approvalId, count: parsed.data.updates.length, reason: r.reason };
}

/** Executor for 'update_reorder_points' (wired into executeAction). */
export async function executeUpdateReorderPoints(
  orgId: string,
  payload: { updates: Array<{ itemId: string; reorderPoint: number; reorderQty?: number }> }
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  let updated = 0;
  for (const u of payload.updates) {
    const res = await query<{ id: string }>(
      `update entities set data = data || jsonb_build_object('reorderPoint', $3::int, 'reorderQty', coalesce($4::int, (data->>'reorderQty')::int), 'reorderPointUpdatedAt', to_char(now(),'YYYY-MM-DD'))
       where org_id=$1 and id=$2 and type='item' returning id`,
      [orgId, u.itemId, u.reorderPoint, u.reorderQty ?? null]
    );
    updated += res.length;
  }
  return { ok: updated > 0, result: { updated } };
}

// --- A11: forecast snapshots + accuracy over time ------------------------------

function mondayUTC(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86_400_000);
  return mon.toISOString().slice(0, 10);
}

/**
 * Persist this cycle's per-item forecast (one snapshot per org+item+week,
 * idempotent). Scoring happens once the horizon has elapsed — prediction
 * accuracy is measured against actuals, not assumed.
 */
export async function recordForecastSnapshots(orgId: string, horizonWeeks = 4): Promise<number> {
  const forecast = await forecastDemand(orgId, 12, horizonWeeks);
  const weekStart = mondayUTC(new Date());
  let saved = 0;
  for (const f of forecast) {
    // snapshots feed the accuracy report owners see — kept on the audit trail
    await audit(orgId, 'system', 'forecast.snapshot', {
      metadata: { item: f.item ?? f.itemId, weekStart, horizonWeeks, weeklyAvg: f.weeklyAvg, projectedUnits: f.projectedUnits },
    });
    const rows = await query<{ id: string }>(
      `insert into forecast_snapshots (org_id, item_id, item_name, week_start, horizon_weeks, forecast_weekly, projected_units)
       select $1, $2, $3, $4::date, $5, $6, $7
       where not exists (
         select 1 from forecast_snapshots where org_id = $1 and item_id = $2 and week_start = $4::date
       ) returning id`,
      [orgId, f.itemId, f.item ?? null, weekStart, horizonWeeks, f.weeklyAvg, f.projectedUnits]
    );
    saved += rows.length;
  }
  return saved;
}

export interface ForecastAccuracyRow {
  itemId: string;
  item: string | null;
  weekStart: string;
  projectedUnits: number;
  actualUnits: number;
  accuracyPct: number;
}

export interface ForecastAccuracyReport {
  scored: number;
  rows: ForecastAccuracyRow[];
  averagePct: number | null;
}

/**
 * Score every snapshot whose horizon has elapsed: projected units vs actual
 * sales-order units over the same window. accuracy = 1 − |proj−actual| /
 * max(proj, actual, 1), floored at 0 — so a forecast of 0 against real
 * demand scores 0, and perfect hits score 100.
 */
export async function scoreForecastAccuracy(orgId: string, minAgeWeeks = 4): Promise<ForecastAccuracyReport> {
  const snaps = await query<{ id: string; item_id: string; item_name: string | null; week_start: string; projected: string }>(
    `select id, item_id, item_name, to_char(week_start, 'YYYY-MM-DD') as week_start, projected_units::text as projected
     from forecast_snapshots
     where org_id = $1 and week_start <= current_date - (($2::int || ' weeks')::interval)
     order by week_start asc limit 200`,
    [orgId, minAgeWeeks]
  );
  const rows: ForecastAccuracyRow[] = [];
  for (const s of snaps) {
    // actuals: the same item's sales-order units over the SAME window the
    // projection covered (item-scoped — an org-wide sum would flatter or
    // punish every item with other products' demand)
    const actual = await query<{ units: string }>(
      `select coalesce(sum(qty), 0) as units from entities
       where org_id = $1 and type = 'sales_order' and item_id = $4 and status != 'cancelled'
         and date >= $2::date and date < $2::date + (($3::int || ' weeks')::interval)`,
      [orgId, s.week_start, minAgeWeeks, s.item_id]
    );
    const projected = Number(s.projected);
    const actualUnits = Number(actual[0]?.units ?? 0);
    const denom = Math.max(projected, actualUnits, 1);
    const accuracyPct = Math.max(0, Math.round((1 - Math.abs(projected - actualUnits) / denom) * 1000)) / 10;
    rows.push({ itemId: s.item_id, item: s.item_name, weekStart: s.week_start, projectedUnits: projected, actualUnits, accuracyPct });
  }
  const averagePct = rows.length ? Math.round((rows.reduce((s, r) => s + r.accuracyPct, 0) / rows.length) * 10) / 10 : null;
  return { scored: rows.length, rows, averagePct };
}

/**
 * Owner-facing summary (Settings card / digest section): the average accuracy
 * and the recent per-item hits/misses. Rows are ordered worst-first so the
 * owner sees the misses without scrolling. Zero snapshots (product too young)
 * reads as an honest "not measured yet", never a fabricated number.
 */
export interface ForecastAccuracySummary {
  scored: number;
  averagePct: number | null;
  verdict: string;
  worst: Array<{ item: string | null; weekStart: string; projectedUnits: number; actualUnits: number; accuracyPct: number }>;
}

export async function forecastAccuracySummary(orgId: string, limit = 5): Promise<ForecastAccuracySummary> {
  const report = await scoreForecastAccuracy(orgId);
  const worst = [...report.rows]
    .sort((a, b) => a.accuracyPct - b.accuracyPct)
    .slice(0, limit)
    .map((r) => ({ item: r.item, weekStart: r.weekStart, projectedUnits: r.projectedUnits, actualUnits: r.actualUnits, accuracyPct: r.accuracyPct }));
  const verdict =
    report.scored === 0
      ? 'Not measured yet — snapshots started collecting this week; accuracy appears once the horizon elapses.'
      : report.averagePct === null
        ? 'No scorable snapshots yet.'
        : report.averagePct >= 85
          ? 'Forecast is tracking real demand well.'
          : report.averagePct >= 60
            ? 'Forecast is in the right range — use reorder suggestions as a floor and review weekly.'
            : 'Forecast misses real demand often — treat suggestions as a starting point and correct them in approvals; every correction makes the next week sharper.';
  return { scored: report.scored, averagePct: report.averagePct, verdict, worst };
}

/** Weekly entrypoint used by the cron: suggest + queue the batched write + snapshot. */
export async function runForecastCycle(orgId: string, horizonWeeks = 4): Promise<ForecastAdjustmentReport & { decision?: string }> {
  const report = await suggestReorderAdjustments(orgId, horizonWeeks);
  if (report.suggestions.length) {
    const r = await proposeReorderPointUpdates(orgId, report.suggestions);
    report.approvalId = r.approvalId;
    report.decision = r.decision;
  }
  try {
    report.snapshotsSaved = await recordForecastSnapshots(orgId, horizonWeeks);
  } catch {
    // snapshotting must never break the forecast cycle
  }
  return report;
}

export type { ForecastPoint };
