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
  if (ex.totalAmount == null) issues.push('Total amount missing — cannot reconcile');
  return issues;
}

/** Mock extractor for dev/CI (no API key): deterministic parse of pasted text. */
function mockExtract(text: string): ExtractedPo {
  // Document numbers keep their prefix (PO-7841, INV-3301, JC/2219) — the
  // prefix identifies the doc TYPE, stripping it loses information.
  const po =
    text.match(/(?:PO|P\.O\.|Order|Invoice|Quote|Quotation|Challan)\s*(?:No\.?|number|#)?\s*[:#]?\s*([A-Z]{1,4}[-\/]?\d{2,6})\b/i)?.[1] ??
    (text.match(/\b(PO|INV|SO|JC)\s*[:#\-\/?]?\s*(\d{3,6})\b/i)?.slice(1, 3).join('-') ?? null);
  const date = text.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const gstin = text.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/)?.[1] ?? null;

  // Party extraction: labelled lines win, then label-free forms. A bare
  // "To:" line is the RECEIVER (our own factory), never the buyer.
  const ourNames =
    /^(precision\s+metalworks|sunfresh\s+foods|greencycle\s+recyclers|texstyle\s+exports|factory\s+ai\s+os)/i;
  const cleanName = (raw: string | undefined): string | null => {
    const v = raw?.trim().replace(/\s+/g, ' ');
    if (!v) return null;
    return v.replace(/^(M\/s\.?|M\/s)\s+/i, '').trim() || null;
  };
  const customer =
    [
      text.match(/(?:From|Customer|Buyer|Party|Ordered\s*by)\s*[:\-]\s*([^\n,]{2,60})/i)?.[1],
      text.match(/M\/s\.?\s+([A-Z][A-Za-z.& ]{2,50})/)?.[1],
      text.match(/\b(?:PO|Order|Invoice|Quote|Challan)(?:\s*(?:No\.?|number|#))?\s*[:#\-]?\s*[A-Z0-9\-\/]+\s*[-\u2013]\s*([A-Z][A-Za-z.& ]{2,40})/)?.[1],
      text.match(/(?:buyer|customer|party)\s*[:\-]?\s*([A-Z][A-Za-z.& ]{2,40})/i)?.[1],
      text.match(/\bfrom\s+([A-Z][A-Za-z.& ]{2,40})/i)?.[1],
      // "PO 7842 - Sundaram Traders" (Hinglish WhatsApp shape)
      text.match(/\b(?:PO|INV|SO)\s*[:#\-]?\s*\d+\s*[-\u2013]\s*([A-Z][A-Za-z.& ]{2,40})/)?.[1],
      // suffix style: "Party: Rao Metal Works" on its own line, or the line
      // after a doc-number line ("Buyer: Greencycle Traders")
      text.match(/\n\s*(?:Buyer|Party|Customer)\s*[:\-]?\s*([A-Z][A-Za-z.& ]{2,40})/)?.[1],
      // trailing party line: "from Naik Traders" already covered; also
      // "... Meena Enterprises" on the line after a PO number
      text.match(/\bPO[\s\-]?\d+\s*\n\s*([A-Z][A-Za-z.& ]{2,40})/)?.[1],
      // bare company line right after a doc-number line ("Purchase Order No.
      // PO-9901 dated …\nShakti Industries orders:")
      text.match(/\n\s*([A-Z][A-Za-z.& ]{2,40}?\s+(?:Industries|Traders|Enterprises|Works|Suppliers|Metals|Recyclers|Foods|Exports))\b/)?.[1],
    ]
      .map(cleanName)
      .find((v): v is string => Boolean(v && !ourNames.test(v))) ?? null;

  // totals: "Grand Total: Rs 27,104", "Total Value 53000", "Amount payable: 26400"
  const total =
    text.match(/(?:grand\s*total|total\s*value|total|value|amount(?:\s+payable)?)\s*[:=\-]?\s*(?:rs\.?|inr|\u20b9)?\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1];

  const lines: PoLine[] = [];
  // A: "item x|× 50 nos @ 240" / "item x 50 nos rate 240"
  const lineA = /([A-Za-z][A-Za-z0-9 \.\-]{2,40}?)\s*[xX\u00d7]\s*(\d[\d,]*)\s*(nos|kg|ltr|pcs)?\s*(?:@|rate)?\s*(?:rs\.?|inr|\u20b9)?\s*([\d,]+(?:\.\d{1,2})?)?/gi;
  // B: "item 50 nos @ 240" / "item 100 nos @ 240 = 24000"
  const lineB = /([A-Za-z][A-Za-z0-9 \.\-]{2,40}?)\s+(\d[\d,]*)\s*(nos|kg|ltr|pcs)\s*(?:@|rate)?\s*(?:rs\.?|inr|\u20b9)?\s*([\d,]+(?:\.\d{1,2})?)?/gi;
  const seen = new Set<string>();
  const push = (m: RegExpExecArray) => {
    const name = m[1]!.trim();
    const key = name.toLowerCase() + '|' + m[2]!;
    if (seen.has(key) || /^\d/.test(name)) return;
    seen.add(key);
    lines.push({
      itemName: name,
      qty: Number(m[2]!.replace(/,/g, '')),
      uom: m[3] ?? null,
      rate: m[4] ? Number(m[4]!.replace(/,/g, '')) : null,
    });
  };
  let m: RegExpExecArray | null;
  while ((m = lineA.exec(text)) !== null) push(m);
  while ((m = lineB.exec(text)) !== null) push(m);
  // C: invoice style — "Item: Laser-cut Plate 6mm" + "Qty: 40 nos   Rate: Rs 620/- each"
  const itemName = text.match(/\b(?:Item|Description)\s*[:\-]\s*([A-Za-z][A-Za-z0-9 \-.]{2,40})/i)?.[1]?.trim();
  const qtyRate = text.match(/\bQty\s*[:\-]?\s*(\d[\d,]*)\s*(nos|kg|ltr|pcs)?[^\n]*?\bRate\s*[:\-]?\s*(?:rs\.?|inr|\u20b9)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (itemName && qtyRate && !seen.has(itemName.toLowerCase() + '|' + qtyRate[1]!)) {
    lines.push({
      itemName,
      qty: Number(qtyRate[1]!.replace(/,/g, '')),
      uom: qtyRate[2] ?? null,
      rate: Number(qtyRate[3]!.replace(/,/g, '')),
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

/**
 * Multimodal intake: a photo of a PO/invoice/challan/job card straight into
 * the same strict schema. Uses a vision-capable model with a data-URL image
 * part; in mock/dev mode (no key) it fails explicitly so the caller can ask
 * for text instead — no silent hallucination of an unread image.
 */
export async function extractDocumentFromImage(
  orgId: string,
  input: { filename?: string; imageBase64: string; mimeType?: string; source?: 'upload' | 'whatsapp' },
  deps: ExtractDeps = {}
): Promise<ExtractionResult & { documentId: string }> {
  const cfg = getModelConfig();
  if (!deps.model && !(cfg.profile === 'prod' && cfg.openRouterApiKey)) {
    throw new Error(
      'Image extraction needs a vision model — set an OpenRouter key in Settings (dev mock is text-only). Paste the text or type it instead.'
    );
  }
  const model = deps.model ?? getModel('fast');
  const mime = input.mimeType ?? 'image/jpeg';
  const { object } = await generateObject({
    model,
    schema: ExtractedPoSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'This is a photo of a purchase order / invoice / challan / handwritten job card from an Indian factory. Extract the fields into the schema. Copy numbers exactly as printed.' },
          { type: 'image', image: `data:${mime};base64,${input.imageBase64}` },
        ],
      },
    ],
  });
  return persistExtraction(orgId, object, {
    mode: 'model',
    filename: input.filename ?? 'photo',
    source: input.source ?? 'upload',
    flagged: false,
    content: `[image:${mime} ${input.imageBase64.length}b]`,
  });
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

  return persistExtraction(orgId, extraction, { mode, filename: input.filename, source: input.source ?? 'upload', flagged, content: input.text.slice(0, 20000) });
}

/** Shared persistence + scoring for both text and image extraction paths. */
async function persistExtraction(
  orgId: string,
  extraction: ExtractedPo,
  opts: { mode: 'model' | 'mock'; filename?: string; source: 'upload' | 'email' | 'whatsapp'; flagged: boolean; content: string }
): Promise<ExtractionResult & { documentId: string }> {
  const validation = validateExtraction(extraction);
  const fieldConfidence: FieldConfidence[] = [
    { field: 'poNumber', confidence: extraction.poNumber ? 0.95 : 0.2 },
    { field: 'customerName', confidence: extraction.customerName ? 0.9 : 0.3 },
    { field: 'poDate', confidence: extraction.poDate ? 0.92 : 0.25 },
    { field: 'totalAmount', confidence: extraction.totalAmount != null ? 0.93 : 0.2 },
    { field: 'lines', confidence: extraction.lines.length ? 0.9 : 0.3 },
  ];
  const overallConfidence = opts.mode === 'mock' ? scoreConfidence(extraction, validation) : fieldConfidence.reduce((s, f) => s + f.confidence, 0) / fieldConfidence.length;
  const needsReview = overallConfidence < REVIEW_THRESHOLD || validation.length > 0 || opts.flagged;

  const doc = await query<{ id: string }>(
    `insert into documents (org_id, kind, filename, source, status, extraction, confidence, content)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [orgId, extraction.kind, opts.filename ?? null, opts.source, needsReview ? 'review' : 'ready', JSON.stringify(extraction), overallConfidence, opts.content]
  );
  const documentId = doc[0]!.id;

  await audit(orgId, 'agent', 'document.extracted', {
    entityType: 'document', entityId: documentId,
    metadata: { mode: opts.mode, confidence: overallConfidence, needsReview, flagged: opts.flagged, filename: opts.filename },
  });

  return { extraction, overallConfidence, fieldConfidence, needsReview, validation, documentId };
}

/** Accept a reviewed document: creates the sales order via policy engine. */
export async function acceptDocument(orgId: string, documentId: string): Promise<{ ok: boolean; soId?: string; approvalId?: string; error?: string; decision?: string }> {
  const rows = await query<{ extraction: string | Record<string, unknown>; status: string }>(
    'select extraction, status from documents where org_id = $1 and id = $2 limit 1',
    [orgId, documentId]
  );
  const doc = rows[0];
  if (!doc) return { ok: false, error: 'document not found' };
  // PGlite parses jsonb already; tolerate raw string too
  const ex = typeof doc.extraction === 'string' ? (JSON.parse(doc.extraction || '{}') as ExtractedPo) : ((doc.extraction ?? {}) as ExtractedPo);

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
