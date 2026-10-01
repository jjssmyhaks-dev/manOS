import crypto from 'node:crypto';
import { query } from '@factory/db';

/**
 * Agent 2 edge case — duplicate submission: the same PO/invoice photo or text
 * sent twice (retention is a way of life on WhatsApp) must not create a
 * second draft. Dedupe on (a) exact content hash and (b) a fuzzy signature
 * of the extracted fields (type + counterparty + amount ± date window).
 */

export interface DuplicateCheckInput {
  orgId: string;
  content?: string;
  fields?: { poNumber?: string | null; totalAmount?: number | null; customerName?: string | null };
  withinDays?: number;
}

export interface DuplicateMatch {
  documentId: string;
  source: string | null;
  createdAt: string;
  matchOn: 'hash' | 'fields';
  confidence: 'exact' | 'likely';
}

export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content.trim().toLowerCase()).digest('hex');
}

/** Find a prior document that matches this submission closely enough to be the same one. */
export async function findDuplicateDocument(input: DuplicateCheckInput): Promise<DuplicateMatch | null> {
  const days = input.withinDays ?? 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  if (input.content) {
    const h = contentHash(input.content);
    const rows = await query<{ id: string; source: string | null; created_at: string }>(
      `select id, source, created_at::text from documents
       where org_id = $1 and content_hash = $2 and created_at >= $3 limit 1`,
      [input.orgId, h, since]
    );
    if (rows[0]) return { documentId: rows[0].id, source: rows[0].source, createdAt: rows[0].created_at, matchOn: 'hash', confidence: 'exact' };
  }

  if (input.fields?.poNumber && input.fields.totalAmount != null) {
    const rows = await query<{ id: string; source: string | null; created_at: string; extraction: Record<string, unknown> | null }>(
      `select id, source, created_at::text, extraction from documents
       where org_id = $1 and created_at >= $2 and status != 'failed'
         and extraction->>'poNumber' = $3
         and abs(coalesce((extraction->>'totalAmount')::numeric, 0) - $4) < 1
       limit 1`,
      [input.orgId, since, input.fields.poNumber, input.fields.totalAmount]
    );
    if (rows[0]) return { documentId: rows[0].id, source: rows[0].source, createdAt: rows[0].created_at, matchOn: 'fields', confidence: 'likely' };
  }

  return null;
}

/** Stamp the hash on a stored document (call at intake time). */
export async function stampContentHash(orgId: string, documentId: string, content: string): Promise<void> {
  await query(`update documents set content_hash = $3 where org_id = $1 and id = $2`, [orgId, documentId, contentHash(content)]);
}
