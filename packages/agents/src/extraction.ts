import { generateObject } from 'ai';
import { z } from 'zod';
import { query, insertEntity, audit } from '@factory/db';
import { isolateUntrusted } from '@factory/core';
import { getModel, getModelConfig } from './models.js';

/**
 * Document intake agent (PRD F4): multimodal LLM extraction to a strict JSON
 * schema (Zod), per-field confidence, validation rules (GSTIN format, totals
 * reconcile), and a human review queue for low confidence.
 */

export const ExtractedPoSchema = z.object({
  kind: z.enum(['po', 'invoice', 'challan', 'quote']).default('po'),
  poNumber: z.string().nullable(),
  poDate: z.string().nullable().describe('YYYY-MM-DD'),
  customerName: z.string().nullable(),
  gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'GSTIN format').nullable().optional(),
  lines: z.array(z.object({
    itemName: z.string(),
    qty: z.number(),
    uom: z.string().nullable().optional(),
    rate: z.number().nullable().optional(),
  })).default([]),
  totalAmount: z.number().nullable(),
  currency: z.string().default('INR'),
  notes: z.string().nullable().optional(),
});

export type ExtractedPo = z.infer<typeof ExtractedPoSchema>;

export interface FieldConfidence {
  field: string;
  confidence: number;
}

export interface ExtractionResult {
  extraction: ExtractedPo;
  overallConfidence: number;
  fieldConfidence: FieldConfidence[];
  needsReview: boolean;
  validation: string[];
  traceId?: string;
}

interface PoLine {
  itemName: string;
  qty: number;
  uom?: string | null;
  rate?: number | null;
}

const REVIEW_THRESHOLD = 0.72;

/** Heuristic confidence: dev-mode deterministic scoring based on field presence. */
function scoreConfidence(ex: ExtractedPo, validation: string[]): number {
  let score = 0.4;
  if (ex.poNumber) score += 0.15;
  if (ex.customerName) score += 0.15;
  if (ex.poDate) score += 0.1;
  if (ex.lines.length > 0) score += 0.15;
  if (ex.totalAmount != null) score += 0.1;
  if (validation.length === 0) score += 0.1;
  return Math.min(0.99, score);
}

export function validateExtraction(ex: ExtractedPo): string[] {
  const issues: string[] = [];
  if (ex.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(ex.gstin)) {
    issues.push(`GSTIN format invalid: ${ex.gstin}`);
  }
  if (ex.lines.length && ex.totalAmount != null) {
    const lineSum = ex.lines.reduce((s, l) => s + (l.qty ?? 0) * (l.rate ?? 0), 0);
    if (ex.lines.every((l) => l.rate != null) && Math.abs(lineSum - ex.totalAmount) > Math.max(1, ex.totalAmount * 0.02)) {
      issues.push(`Line totals (₹${lineSum.toFixed(2)}) don't reconcile with stated total (₹${ex.totalAmount.toFixed(2)})`);
    }
  }
  if (!ex.customerName) issues.push('Customer name missing — needs mapping');
  if (!ex.poNumber) issues.push('PO number missing');
  return issues;
}

/** Mock extractor for dev/CI (no API key): deterministic parse of pasted text. */
function mockExtract(text: string): ExtractedPo {
  const po = text.match(/(?:PO|P\.O\.|Order)\s*(?:No\.?|number|#)?\s*[:#]?\s*([A-Z0-9\-\/]{3,})/i)?.[1] ?? null;
  const date = text.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const gstin = text.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/)?.[1] ?? null;
  const customer = text.match(/(?:From|Customer|Buyer|Party)\s*[:\-]\s*([^\n,]{2,60})/i)?.[1]?.trim() ?? null;
  const total = text.match(/(?:total|value|amount)\s*[:\-]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1];
  const lines: PoLine[] = [];
  const lineRe = /([A-Za-z][A-Za-z0-9 \.\-]{2,40}?)\s*[x×@]\s*(\d+)\s*(nos|kg|ltr|pcs)?\s*(?:@|rate)?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    lines.push({
      itemName: m[1]!.trim(),
      qty: Number(m[2]!.replace(/,/g, '')),
      uom: m[3] ?? null,
      rate: m[4] ? Number(m[4]!.replace(/,/g, '')) : null,
    });
  }
  return {
    kind: 'po',
    poNumber: po, poDate: date, customerName: customer, gstin: gstin ?? undefined,
    lines, totalAmount: total ? Number(total.replace(/,/g, '')) : null,
    currency: 'INR', notes: null,
  };
}

export interface ExtractDeps {
  model?: Parameters<typeof generateObject>[0]['model'];
}

export async function extractDocument(
  orgId: string,
  input: { filename?: string; text: string; source?: 'upload' | 'email' | 'whatsapp' },
  deps: ExtractDeps = {}
): Promise<ExtractionResult & { documentId: string }> {
  const cfg = getModelConfig();
  const { wrapped, flagged } = isolateUntrusted(input.source ?? 'upload', input.text);

  let extraction: ExtractedPo;
  let mode: 'model' | 'mock';
  if (deps.model || (cfg.profile === 'prod' && cfg.openRouterApiKey)) {
    const model = deps.model ?? getModel('fast');
    const { object } = await generateObject({
      model,
      schema: ExtractedPoSchema,
      prompt: `Extract the purchase order / invoice fields from this document text into the schema. Document:\n${wrapped}`,
    });
    extraction = object;
    mode = 'model';
  } else {
    extraction = mockExtract(input.text);
    mode = 'mock';
  }

  const validation = validateExtraction(extraction);
  const fieldConfidence: FieldConfidence[] = [
    { field: 'poNumber', confidence: extraction.poNumber ? 0.95 : 0.2 },
    { field: 'customerName', confidence: extraction.customerName ? 0.9 : 0.3 },
    { field: 'poDate', confidence: extraction.poDate ? 0.92 : 0.25 },
    { field: 'totalAmount', confidence: extraction.totalAmount != null ? 0.93 : 0.2 },
    { field: 'lines', confidence: extraction.lines.length ? 0.9 : 0.3 },
  ];
  const overallConfidence = mode === 'mock' ? scoreConfidence(extraction, validation) : fieldConfidence.reduce((s, f) => s + f.confidence, 0) / fieldConfidence.length;
  const needsReview = overallConfidence < REVIEW_THRESHOLD || validation.length > 0 || flagged;

  // persist document + review record
  const doc = await query<{ id: string }>(
    `insert into documents (org_id, kind, filename, source, status, extraction, confidence, content)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [orgId, extraction.kind, input.filename ?? null, input.source ?? 'upload', needsReview ? 'review' : 'ready', JSON.stringify(extraction), overallConfidence, input.text.slice(0, 20000)]
  );
  const documentId = doc[0]!.id;

  await audit(orgId, 'agent', 'document.extracted', {
    entityType: 'document', entityId: documentId,
    metadata: { mode, confidence: overallConfidence, needsReview, flagged, filename: input.filename },
  });

  return { extraction, overallConfidence, fieldConfidence, needsReview, validation, documentId };
}

/** Accept a reviewed document: creates the sales order via policy engine. */
export async function acceptDocument(orgId: string, documentId: string): Promise<{ ok: boolean; soId?: string; approvalId?: string; error?: string; decision?: string }> {
  const rows = await query<{ extraction: string; status: string }>(
    'select extraction, status from documents where org_id = $1 and id = $2 limit 1',
    [orgId, documentId]
  );
  const doc = rows[0];
  if (!doc) return { ok: false, error: 'document not found' };
  const ex = JSON.parse(doc.extraction ?? '{}') as ExtractedPo;

  // match customer + items to master
  const cust = ex.customerName
    ? await query<{ id: string }>(`select id from entities where org_id=$1 and type='party' and data->>'name' ilike $2 limit 1`, [orgId, `%${ex.customerName}%`])
    : [];
  const firstLine = ex.lines[0];
  const item = firstLine
    ? await query<{ id: string }>(`select id from entities where org_id=$1 and type='item' and data->>'name' ilike $2 limit 1`, [orgId, `%${firstLine.itemName}%`])
    : [];

  const { checkPolicyAndQueue } = await import('@factory/core');
  const payload = {
    customerId: cust[0]?.id, customer: ex.customerName, itemId: item[0]?.id, item: firstLine?.itemName,
    qty: firstLine?.qty ?? 0, rate: firstLine?.rate ?? 0, poNumber: ex.poNumber,
  };
  const res = await checkPolicyAndQueue(
    {
      orgId, actionType: 'so_create', entityType: 'sales_order',
      payload, preview: `Create sales order from document ${documentId}: ${ex.poNumber ?? 'no PO no.'} — ${firstLine?.itemName ?? ''} × ${firstLine?.qty ?? 0}`,
      risk: 'write',
    },
    (pl) => import('./tools/write.js').then((w) => w.executeAction(orgId, 'so_create', pl as Record<string, unknown>))
  );
  if (res.decision !== 'ask') {
    await query(`update documents set status='ready' where id=$1`, [documentId]);
  }
  await query(`update documents set status = case when $2 = 'ask' then 'ready' else status end, entity_id = coalesce(entity_id, $3) where id=$1`,
    [documentId, res.decision, res.approvalId ?? null]);
  return { ok: true, soId: undefined, approvalId: res.approvalId, decision: res.decision };
}
