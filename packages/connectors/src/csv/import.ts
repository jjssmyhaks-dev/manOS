import { upsertEntityBySource, audit, type EntityRow } from '@factory/db';
import type { Connector, SyncEntity, NormalizedRecord, SyncResult, AuthResult, WebhookEvent, WebhookResult } from '../interface.js';

/**
 * CSV/Excel import (P0 fallback): parses Tally-exported or hand-made sheets.
 * Runs server-side in small chunks (serverless-safe). Rows are upserted with
 * source='csv' + sourceId so re-imports update instead of duplicating.
 */

export interface CsvParseResult {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export function parseCsv(text: string): CsvParseResult {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const rows: string[][] = [];
  let cur = '';
  let inQ = false;
  const splitLines = (line: string): string[] => {
    const cells: string[] = [];
    cur = '';
    inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  };

  for (const line of lines) rows.push(splitLines(line));
  const headers = rows[0]!.map((h) => h.trim());
  const data = rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
  return { headers, rows: data };
}

const num = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = Number(v.replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

/** Column synonyms accepted (Tally export names + plain names). */
const FIELD_MAP: Record<string, string[]> = {
  code: ['code', 'item code', 'sku', 'part no', 'ledger name'],
  name: ['name', 'item name', 'description', 'party name', 'particulars'],
  kind: ['kind', 'type', 'party type', 'record type'],
  qty: ['qty', 'quantity', 'stock on hand', 'closing balance'],
  rate: ['rate', 'price', 'std rate', 'standard rate'],
  amount: ['amount', 'value', 'total', 'invoice amount'],
  date: ['date', 'invoice date', 'order date', 'voucher date'],
  status: ['status'],
  gstin: ['gstin', 'gst no', 'gst number', 'gstIN'],
  reorderPoint: ['reorder point', 'min level', 'minimum stock'],
  reorderQty: ['reorder qty', 'reorder quantity', 'order qty'],
  uom: ['uom', 'unit', 'units'],
};

function mapRow(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, synonyms] of Object.entries(FIELD_MAP)) {
    for (const s of synonyms) {
      const hit = Object.keys(row).find((k) => k.toLowerCase() === s);
      if (hit && row[hit]) { out[field] = row[hit]!; break; }
    }
  }
  return out;
}

export function rowToEntity(orgId: string, kind: string, row: Record<string, string>): Partial<EntityRow> & { type: 'party' | 'item' } {
  const m = mapRow(row);
  const isParty = kind === 'party' || !!m.gstin || /party|customer|vendor/i.test(m.kind ?? '');
  const sourceId = m.code || m.name || Math.random().toString(36).slice(2);
  if (isParty) {
    return {
      type: 'party', orgId, source: 'csv', sourceId,
      code: m.code, name: m.name, status: m.status ?? 'active',
      data: { kind: /vendor|supplier/i.test(m.kind ?? '') ? 'vendor' : 'customer', gstin: m.gstin, raw: row },
    };
  }
  return {
    type: 'item', orgId, source: 'csv', sourceId,
    code: m.code, name: m.name, status: m.status ?? 'active',
    rate: m.rate ? Number(m.rate) : undefined, qty: m.qty ? Number(m.qty) : undefined,
    data: {
      uom: m.uom, reorderPoint: num(m.reorderPoint), reorderQty: num(m.reorderQty),
      stockOnHand: num(m.qty) ?? 0, stdRate: num(m.rate), raw: row,
    },
  };
}

export class CsvConnector implements Connector {
  readonly type = 'csv';

  async auth(config: Record<string, unknown>): Promise<AuthResult> {
    return { ok: true, mode: 'file' };
  }

  /** Import CSV text as parties/items. */
  async importCsv(orgId: string, csvText: string, kindHint?: 'party' | 'item'): Promise<{ parties: number; items: number }> {
    const { rows } = parseCsv(csvText);
    let parties = 0, items = 0;
    for (const row of rows) {
      const kind = kindHint ?? (/vendor|customer|party|gstin/i.test(Object.keys(row).join(' ') + JSON.stringify(row)) ? 'party' : 'item');
      const ent = rowToEntity(orgId, kind, row);
      await upsertEntityBySource(orgId, 'csv', ent.sourceId ?? ent.name ?? ent.code ?? '', ent);
      if (ent.type === 'party') parties++; else items++;
    }
    await audit(orgId, 'system', 'connector.csv_import', { metadata: { parties, items } });
    return { parties, items };
  }

  async sync(orgId: string, connectorId: string, entity: SyncEntity): Promise<SyncResult> {
    // CSV is pull-by-upload; sync() replays nothing
    return { connectorId, entity, pulled: 0, pushed: 0, errors: [], lastCursor: null };
  }

  async read(orgId: string, entity: SyncEntity, id?: string): Promise<NormalizedRecord[]> {
    void orgId; void entity; void id;
    return [];
  }

  async write(orgId: string, action: { type: string; payload: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    void orgId; void action;
    return { ok: false, error: 'CSV connector is read-only' };
  }

  async webhookHandler(event: WebhookEvent): Promise<WebhookResult> {
    return { ok: false, error: 'CSV connector has no webhooks' };
  }

  async health(orgId: string): Promise<{ status: 'connected' | 'error' | 'disconnected'; lastSyncAt?: string; lastError?: string }> {
    const { query } = await import('@factory/db');
    const rows = await query<{ last_sync_at: string | null }>(
      `select last_sync_at from connectors where org_id=$1 and type='csv' limit 1`, [orgId]
    );
    return { status: 'connected', lastSyncAt: rows[0]?.last_sync_at ?? undefined };
  }
}
