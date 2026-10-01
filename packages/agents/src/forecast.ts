import { z } from 'zod';
import { query } from '@factory/db';
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

/** Weekly entrypoint used by the cron: suggest + queue the batched write. */
export async function runForecastCycle(orgId: string, horizonWeeks = 4): Promise<ForecastAdjustmentReport & { decision?: string }> {
  const report = await suggestReorderAdjustments(orgId, horizonWeeks);
  if (report.suggestions.length) {
    const r = await proposeReorderPointUpdates(orgId, report.suggestions);
    report.approvalId = r.approvalId;
    report.decision = r.decision;
  }
  return report;
}

export type { ForecastPoint };
