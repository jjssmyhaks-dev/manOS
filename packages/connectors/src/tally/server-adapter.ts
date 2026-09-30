import { query, upsertEntityBySource, audit } from '@factory/db';
import {
  mastersRequest, stockItemsRequest, vouchersRequest, salesVoucherImport,
  parseLedgers, parseStockItems, parseVouchers, escapeXml, DEFAULT_TALLY_PORT,
  type TallyLedger, type TallyStockItem, type TallyVoucher,
} from './xml.js';

/**
 * Server-side Tally adapter (real XML-over-HTTP to TallyPrime's OLE port).
 * Use when Tally is reachable over the network from this server (LAN deploy,
 * VPN, or the Tally machine runs the desktop agent). The desktop agent path
 * (apps/connector-desktop + /api/connector/[id]) remains the zero-config
 * default; this adapter powers the "Test connection" and "Sync now" buttons
 * with a live round-trip so setup problems surface at setup time, not days
 * later in monitoring.
 */

export interface TallyServerConfig {
  host: string;
  port: number;
  company: string;
}

export function parseTallyServerConfig(raw: unknown): TallyServerConfig | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  const host = String(c.host ?? '').trim();
  const company = String(c.company ?? '').trim();
  if (!host || !company) return null;
  const port = Number(c.port ?? DEFAULT_TALLY_PORT);
  return { host, port: Number.isFinite(port) && port > 0 ? port : DEFAULT_TALLY_PORT, company };
}

async function tallyRequest(cfg: TallyServerConfig, xml: string, timeoutMs = 8000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: xml,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Tally responded HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Live test: ask Tally for its company list and check the configured company exists. */
export async function tallyTestConnection(cfg: TallyServerConfig): Promise<{ ok: boolean; companies?: string[]; error?: string }> {
  try {
    // Tally answers a bare prime-xml with the company list; the classic
    // "List of Accounts" export also carries <NAME> entries per ledger.
    const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER><BODY><DESC><REPORTNAME>List of Companies</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
    const text = await tallyRequest(cfg, xml);
    if (!text.trim()) return { ok: false, error: 'Tally returned an empty response — is TallyPrime running with OLE enabled?' };
    const companies: string[] = [];
    const re = /<NAME[^>]*>([^<]+)<\/NAME>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) companies.push(m[1]!.trim());
    const unique = [...new Set(companies)];
    if (unique.length === 0) return { ok: false, error: 'Tally reachable but no company names in response' };
    const wanted = cfg.company.trim().toLowerCase();
    const match = unique.find((c) => c.toLowerCase() === wanted);
    return {
      ok: true,
      companies: unique,
      error: match ? undefined : `Connected — but company "${cfg.company}" not found. Open it in Tally, or use one of: ${unique.slice(0, 4).join(', ')}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('abort')) {
      return { ok: false, error: `No response from ${cfg.host}:${cfg.port} in 8s — check host/port and that TallyPrime is running` };
    }
    return { ok: false, error: `Could not reach Tally at ${cfg.host}:${cfg.port} (${msg}) — check that TallyPrime is running with OLE port enabled on that machine` };
  }
}

/** Pull masters + recent vouchers into entities (source='tally_direct'). */
export async function tallySync(orgId: string, connectorId: string, cfg: TallyServerConfig, opts: { vouchersDays?: number } = {}): Promise<{ parties: number; items: number; vouchers: number; errors: string[] }> {
  const errors: string[] = [];
  let parties = 0;
  let items = 0;
  let vouchers = 0;

  try {
    const xml = await tallyRequest(cfg, mastersRequest(cfg.company));
    const ledgers: TallyLedger[] = parseLedgers(xml);
    for (const l of ledgers) {
      if (!l.name) continue;
      const kind = /sundry creditor|bank|duties|duties & taxes|capital account|loans|current liabilities|indirect expenses|direct expenses|sales account|purchase account/i.test(l.parent) ? 'other' : 'customer';
      await upsertEntityBySource(orgId, 'tally_direct', `ledger:${l.guid || l.name}`, {
        type: 'party',
        code: l.guid || undefined,
        name: l.name,
        data: { kind, tallyParent: l.parent, gstin: l.gstin ?? null, alterId: l.alterId, source: 'tally_direct' },
      });
      parties++;
    }
  } catch (e) {
    errors.push(`masters: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const xml = await tallyRequest(cfg, stockItemsRequest(cfg.company));
    const stockItems: TallyStockItem[] = parseStockItems(xml);
    for (const s of stockItems) {
      await upsertEntityBySource(orgId, 'tally_direct', `item:${s.guid || s.name}`, {
        type: 'item',
        name: s.name,
        data: { uom: s.baseUnit, alterId: s.alterId, source: 'tally_direct' },
      });
      items++;
    }
  } catch (e) {
    errors.push(`stock items: ${e instanceof Error ? e.message : String(e)}`);
  }

  const days = opts.vouchersDays ?? 90;
  try {
    const to = new Date();
    const from = new Date(Date.now() - days * 86400_000);
    const xml = await tallyRequest(cfg, vouchersRequest(cfg.company, from.toISOString(), to.toISOString()));
    const vs: TallyVoucher[] = parseVouchers(xml);
    for (const v of vs.slice(0, 500)) {
      await upsertEntityBySource(orgId, 'tally_direct', `voucher:${v.guid || v.voucherNumber}`, {
        type: 'invoice',
        code: v.voucherNumber,
        status: /sales/i.test(v.voucherType) ? 'sent' : 'received',
        amount: Math.abs(v.amount),
        date: /^\d{8}$/.test(v.date) ? `${v.date.slice(0, 4)}-${v.date.slice(4, 6)}-${v.date.slice(6, 8)}` : undefined,
        data: { voucherType: v.voucherType, party: v.party, alterId: v.alterId, source: 'tally_direct' },
      });
      vouchers++;
    }
  } catch (e) {
    errors.push(`vouchers: ${e instanceof Error ? e.message : String(e)}`);
  }

  await query(`update connectors set last_sync_at = now(), status = $2, last_error = $3 where id = $1`, [
    connectorId,
    errors.length && !parties && !items && !vouchers ? 'error' : 'connected',
    errors[0] ?? null,
  ]);
  await audit(orgId, 'connector', 'tally.sync', { metadata: { parties, items, vouchers, errors: errors.length } });
  return { parties, items, vouchers, errors };
}

/** Push an approved voucher straight into Tally. */
export async function tallyPushVoucher(
  orgId: string,
  cfg: TallyServerConfig,
  voucher: { voucherNo: string; date: string; partyLedger: string; lines: Array<{ item: string; qty: number; rate: number; amount: number }>; totalAmount: number; narration?: string; kind?: 'sales' | 'purchase' }
): Promise<{ ok: boolean; error?: string; response?: string }> {
  try {
    const xml = voucher.kind === 'purchase'
      ? (await import('./xml.js')).purchaseVoucherImport({ company: cfg.company, ...voucher })
      : salesVoucherImport({ company: cfg.company, ...voucher });
    const text = await tallyRequest(cfg, xml, 12000);
    // Tally replies with an IMPORTED / line-level error envelope
    const ok = /CREATED|Imported|SUCCESS/i.test(text) || /<CREATED>\d+<\/CREATED>/.test(text);
    await audit(orgId, 'connector', 'tally.push', { metadata: { voucherNo: voucher.voucherNo, ok, response: text.slice(0, 200) } });
    if (!ok) return { ok: false, error: `Tally did not confirm creation: ${text.slice(0, 160)}`, response: text.slice(0, 500) };
    return { ok: true, response: text.slice(0, 500) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit(orgId, 'connector', 'tally.push_error', { metadata: { voucherNo: voucher.voucherNo, error: msg } });
    return { ok: false, error: msg };
  }
}

export function escapeTallyXml(s: string): string {
  return escapeXml(s);
}
