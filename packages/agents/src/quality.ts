import { z } from 'zod';
import { query } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { executeAction } from './tools/write.js';
import { recordAgentAction } from './activity.js';
import { getModel, getModelConfig } from './models.js';

/**
 * Agent 9 — Quality (spec): structured inspections plus defect intake.
 * Two paths, mirroring the spec:
 *  1. Checklist path — the inspector completes the pack's checklist in-app;
 *     createInspectionRecord is low-risk operational logging (policy may set
 *     it auto).
 *  2. Photo path — a defect photo (WhatsApp or upload) is classified by a
 *     multimodal call with a strict Zod schema; a detected defect drafts an
 *     NCR (+CAPA) that pulls SIMILAR PAST DEFECTS via pgvector/embedding
 *     search to suggest a likely root cause. NCR/CAPA always queue for
 *     approval — they touch supplier/customer relationships.
 * A repeated defect pattern on the same item/supplier escalates as a TREND
 * (digest line), not just another one-off NCR.
 */

export const DefectSchema = z.object({
  defectType: z.string().describe('e.g. scratch, dent, dimensional-off, porosity, colour, leak'),
  severity: z.enum(['low', 'medium', 'high', 'critical']).describe('Critical = safety/functional failure; cosmetic is low'),
  affectedQty: z.number().int().nonnegative().default(1),
  description: z.string().max(400).describe('One-line human description of what is visible'),
});
export type Defect = z.infer<typeof DefectSchema>;

/** Vision classification of a defect photo (needs the live key; clear error otherwise). */
export async function extractDefectFromPhoto(imageBase64: string, mimeType = 'image/jpeg'): Promise<Defect> {
  const cfg = getModelConfig();
  if (!(cfg.profile === 'prod' && cfg.openRouterApiKey)) {
    throw new Error('Defect photos need a live AI key — or log the inspection via the checklist instead.');
  }
  const { generateObject } = await import('ai');
  const { object } = await generateObject({
    model: getModel('fast'),
    schema: DefectSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Classify this manufacturing defect photo for an Indian MSME factory QC log. Identify defect type, severity, how many parts are affected and a one-line description.' },
          { type: 'image', image: `data:${mimeType};base64,${imageBase64}` },
        ],
      },
    ],
  });
  return object;
}

export interface InspectionInput {
  itemRef?: string;
  jobCardCode?: string;
  checklistKey?: string;
  results: Array<{ item: string; pass: boolean; note?: string }>;
  inspector?: string;
}

/** Checklist path: record the inspection, escalate automatically on failure. */
export async function createInspectionRecord(orgId: string, input: InspectionInput): Promise<{ ok: boolean; inspectionId: string; failed: number }> {
  const failed = input.results.filter((r) => !r.pass).length;
  const rows = await query<{ id: string }>(
    `insert into entities (id, org_id, type, status, code, source, data)
     values (gen_random_uuid()::text, $1, 'inspection', $2, 'INS-' || to_char(now(),'YYMMDDHH24MISS'), 'agent', $3::jsonb) returning id`,
    [
      orgId,
      failed > 0 ? 'ncr' : 'passed',
      JSON.stringify({
        itemRef: input.itemRef ?? null,
        jobCardCode: input.jobCardCode ?? null,
        checklistKey: input.checklistKey ?? null,
        inspector: input.inspector ?? 'inspector',
        results: input.results,
        failed,
      }),
    ]
  );
  // trust layer: failed inspections escalate visibly (they seed an NCR next)
  await recordAgentAction({
    orgId,
    actor: `user:${input.inspector ?? 'inspector'}`,
    actionType: 'inspection_recorded',
    summary: failed > 0
      ? `Inspection failed ${failed}/${input.results.length} checks${input.itemRef ? ` on ${input.itemRef}` : ''} — NCR follow-up recommended`
      : `Inspection passed (${input.results.length} checks)${input.itemRef ? ` on ${input.itemRef}` : ''}`,
    reason: failed > 0 ? 'Failed checks escalate automatically; the NCR draft rides the policy engine' : 'Operational QC logging',
    sources: input.jobCardCode ? [{ type: 'job_card', label: `Job card ${input.jobCardCode}` }] : [],
    entityType: 'inspection',
    entityId: rows[0]!.id,
    status: 'executed',
    metadata: { failed, checklistKey: input.checklistKey ?? null },
  });
  return { ok: true, inspectionId: rows[0]!.id, failed };
}

/** Similar historical NCRs — embedding search with a keyword fallback. */
async function similarPastDefects(orgId: string, description: string, defectType: string): Promise<Array<{ code: string | null; summary: string; when: string }>> {
  try {
    const { searchSimilar } = await import('./embeddings.js');
    const hits = await searchSimilar(orgId, `${defectType} ${description}`, 3);
    return hits
      .filter((h) => h.kind === 'ncr' || /defect|ncr|rework|reject/i.test(h.content))
      .map((h) => ({ code: h.title ?? null, summary: h.content.slice(0, 140), when: '' }));
  } catch {
    // fall through to keyword history
  }
  const rows = await query<{ code: string | null; data: Record<string, unknown>; created_at: string }>(
    `select code, data, created_at::text from entities
     where org_id=$1 and type='ncr' and (data->>'defectType' ilike $2 or data->>'description' ilike $3)
     order by created_at desc limit 3`,
    [orgId, `%${defectType}%`, `%${description.slice(0, 24)}%`]
  );
  return rows.map((r) => ({
    code: r.code,
    summary: String((r.data as { description?: string }).description ?? ''),
    when: r.created_at.slice(0, 10),
  }));
}

/** Trend check: 3+ similar defects on the same item in 30 days → escalate. */
async function detectDefectTrend(orgId: string, defectType: string | null, itemRef: string | null): Promise<string | null> {
  const rows = await query<{ c: string }>(
    `select count(*) as c from entities
     where org_id=$1 and type='ncr' and created_at >= now() - interval '30 days'
       and ($2::text is null or data->>'defectType' = $2)
       and ($3::text is null or data->>'itemRef' = $3)`,
    [orgId, defectType, itemRef]
  );
  const n = Number(rows[0]?.c ?? 0) + 1; // +1 for the one being filed now
  return n >= 3 ? `Trend alert: ${n} similar defects in 30 days — treat as a systemic issue, not a one-off.` : null;
}

export interface NcrDraftResult {
  decision: string;
  approvalId?: string;
  ncrCode?: string;
  similar: Array<{ code: string | null; summary: string; when: string }>;
  trendAlert: string | null;
  reason: string;
}

/** Photo path outcome → NCR (+CAPA) draft through the policy engine. */
export async function draftNcr(
  orgId: string,
  defect: Defect,
  meta: { itemRef?: string; jobCardCode?: string; source?: 'photo' | 'manual'; inspectionId?: string } = {}
): Promise<NcrDraftResult> {
  const similar = await similarPastDefects(orgId, defect.description, defect.defectType);
  const trendAlert = await detectDefectTrend(orgId, defect.defectType, meta.itemRef ?? null);

  const capaSuggestion =
    similar.length > 0
      ? `Past similar NCR${similar.length > 1 ? 's' : ''}: ${similar.map((s) => s.code ?? 'NCR').join(', ')}. Likely root cause family repeats — check the earlier corrective action held.`
      : 'No similar past defects found — fresh root-cause analysis needed.';

  const payload = {
    defectType: defect.defectType,
    severity: defect.severity,
    affectedQty: defect.affectedQty,
    description: defect.description,
    itemRef: meta.itemRef ?? null,
    jobCardCode: meta.jobCardCode ?? null,
    inspectionId: meta.inspectionId ?? null,
    source: meta.source ?? 'photo',
    capaSuggestion,
    similarPast: similar,
    trendAlert,
  };

  const r = await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'create_ncr',
      entityType: 'ncr',
      payload,
      preview: `NCR draft — ${defect.defectType} (${defect.severity}) ×${defect.affectedQty}: ${defect.description}${trendAlert ? ' — TREND' : ''}`,
      risk: 'write',
    },
    (pl) => executeAction(orgId, 'create_ncr', pl as Record<string, unknown>)
  );

  return {
    decision: r.decision,
    approvalId: r.approvalId,
    similar,
    trendAlert,
    reason: r.reason,
  };
}

/** Executor for the 'create_ncr' action type (wired into executeAction). */
export async function executeCreateNcr(
  orgId: string,
  payload: Record<string, unknown>,
  _via?: unknown
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const p = payload as { defectType?: string; severity?: string; affectedQty?: number; description?: string; itemRef?: string | null; jobCardCode?: string | null; capaSuggestion?: string; source?: string };
  const rows = await query<{ id: string; code: string | null }>(
    `insert into entities (id, org_id, type, status, code, source, data)
     values (gen_random_uuid()::text, $1, 'ncr', 'open', 'NCR-' || to_char(now(),'YYMMDDHH24MISS'), 'agent', $2::jsonb) returning id, code`,
    [
      orgId,
      JSON.stringify({
        defectType: p.defectType ?? 'unclassified',
        severity: p.severity ?? 'medium',
        affectedQty: p.affectedQty ?? 1,
        description: p.description ?? '',
        itemRef: p.itemRef ?? null,
        jobCardCode: p.jobCardCode ?? null,
        capa: p.capaSuggestion ?? null,
        source: p.source ?? 'photo',
        createdAt: new Date().toISOString(),
      }),
    ]
  );
  return { ok: true, result: { ncrId: rows[0]!.id, ncrCode: rows[0]!.code } };
}
