import { query, upsertEntityBySource, audit } from '@factory/db';
import type {
  Connector, SyncEntity, NormalizedRecord, SyncResult, AuthResult,
  WebhookEvent, WebhookResult,
} from './interface.js';

/**
 * QuickBooks Online — third accounting connector on the same framework as
 * Zoho Books: live connection test, incremental-ish sync (customers, items,
 * invoices) upserted by QBO id, and approved invoice push.
 *
 * Auth: OAuth2 refresh-token flow against Intuit's platform endpoints.
 * Credentials come from the Intuit developer portal (client id/secret +
 * refresh token with accounting scope) plus the company realm id. An OAuth
 * redirect flow can be added on the same pattern as Zoho when the app's
 * Intuit client is registered; the test/sync/push framework is identical.
 */

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  realmId: string;
  environment: 'sandbox' | 'production';
}

export function parseQboConfig(raw: unknown): QboConfig | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  const clientId = String(c.clientId ?? c.client_id ?? '').trim();
  const clientSecret = String(c.clientSecret ?? c.client_secret ?? '').trim();
  const refreshToken = String(c.refreshToken ?? c.refresh_token ?? '').trim();
  const realmId = String(c.realmId ?? c.realm_id ?? '').trim();
  if (!clientId || !clientSecret || !refreshToken || !realmId) return null;
  const environment = String(c.environment ?? 'sandbox') === 'production' ? 'production' : 'sandbox';
  return { clientId, clientSecret, refreshToken, realmId, environment };
}

export function qboBaseUrl(environment: QboConfig['environment']): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com/v3/company'
    : 'https://sandbox-quickbooks.api.intuit.com/v3/company';
}

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// --- OAuth redirect flow (mirrors the Zoho nonce-callback pattern) -----------

export interface QboOAuthEnv {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'production';
}

export function qboOAuthEnv(): QboOAuthEnv | null {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const environment = (process.env.QBO_ENV as QboConfig['environment']) === 'production' ? 'production' : 'sandbox';
  return { clientId, clientSecret, environment };
}

/** Intuit consent screen; Intuit appends ?code=&realmId= to the redirect. */
export function qboAuthorizeUrl(env: QboOAuthEnv, redirectUri: string, state: string): string {
  const url = new URL('https://appcenter.intuit.com/connect/oauth2');
  url.searchParams.set('client_id', env.clientId);
  url.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface QboExchangeResult {
  ok: boolean;
  refreshToken?: string;
  error?: string;
}

/** Exchange the authorization code (+ realm id) for a refresh token. */
export async function qboExchangeCode(env: QboOAuthEnv, code: string, redirectUri: string): Promise<QboExchangeResult> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${env.clientId}:${env.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.refresh_token) return { ok: false, error: data.error_description ?? data.error ?? `HTTP ${res.status}` };
    return { ok: true, refreshToken: data.refresh_token };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(cfg: QboConfig): Promise<string> {
  const key = `qbo:${cfg.clientId}:${cfg.refreshToken.slice(-8)}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`QuickBooks token refresh failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  tokenCache.set(key, { token: data.access_token!, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token!;
}

/** Live test: fetch the company info for the configured realm. */
export async function qboTestConnection(cfg: QboConfig): Promise<{ ok: boolean; companyName?: string; error?: string }> {
  try {
    const token = await accessToken(cfg);
    const res = await fetch(`${qboBaseUrl(cfg.environment)}/${cfg.realmId}/companyinfo/${cfg.realmId}?minorversion=65`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const data = (await res.json().catch(() => ({}))) as { CompanyInfo?: { CompanyName?: string }; Fault?: { Error?: Array<{ Message?: string }> } };
    const fault = data.Fault?.Error?.[0]?.Message;
    if (!res.ok || !data.CompanyInfo) return { ok: false, error: fault ?? `HTTP ${res.status}` };
    return { ok: true, companyName: data.CompanyInfo.CompanyName ?? 'QuickBooks company' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface QboRow {
  Id?: string;
  DisplayName?: string;
  Name?: string;
  Sku?: string;
  UnitPrice?: number;
  QtyOnHand?: number;
  TotalAmt?: number;
  Balance?: number;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  CustomerRef?: { name?: string };
  EmailStatus?: string;
  Type?: string;
}

async function qboQuery(cfg: QboConfig, sql: string): Promise<QboRow[]> {
  const token = await accessToken(cfg);
  const url = `${qboBaseUrl(cfg.environment)}/${cfg.realmId}/query?minorversion=65&query=${encodeURIComponent(sql)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const data = (await res.json().catch(() => ({}))) as { QueryResponse?: { Customer?: QboRow[]; Item?: QboRow[]; Invoice?: QboRow[] }; Fault?: { Error?: Array<{ Message?: string }> } };
  if (!res.ok) throw new Error(data.Fault?.Error?.[0]?.Message ?? `query HTTP ${res.status}`);
  return data.QueryResponse?.Customer ?? data.QueryResponse?.Item ?? data.QueryResponse?.Invoice ?? [];
}

export class QuickBooksConnector implements Connector {
  readonly type = 'quickbooks';

  async auth(config: Record<string, unknown>): Promise<AuthResult> {
    const cfg = parseQboConfig(config);
    if (!cfg) return { ok: false, mode: 'oauth', error: 'clientId, clientSecret, refreshToken and realmId are all required' };
    const test = await qboTestConnection(cfg);
    return test.ok ? { ok: true, mode: 'oauth' } : { ok: false, mode: 'oauth', error: test.error };
  }

  async sync(orgId: string, connectorId: string, entity: SyncEntity): Promise<SyncResult> {
    const row = await query<{ config: Record<string, unknown> }>('select config from connectors where id = $1', [connectorId]);
    const cfg = parseQboConfig(row[0]?.config);
    if (!cfg) return { connectorId, entity, pulled: 0, pushed: 0, errors: ['connector not configured'], lastCursor: null };

    const errors: string[] = [];
    let pulled = 0;
    try {
      if (entity === 'parties' || entity === 'ledgers') {
        const rows = await qboQuery(cfg, 'select * from Customer maxresults 100');
        for (const r of rows) {
          await upsertEntityBySource(orgId, 'quickbooks', `customer:${r.Id}`, {
            type: 'party',
            code: r.Id,
            name: r.DisplayName,
            data: { kind: 'customer', source: 'quickbooks' },
          });
          pulled++;
        }
      }
      if (entity === 'items' || entity === 'stock_items') {
        const rows = await qboQuery(cfg, 'select * from Item where Type = \'Inventory\' maxresults 100');
        for (const r of rows) {
          await upsertEntityBySource(orgId, 'quickbooks', `item:${r.Id}`, {
            type: 'item',
            code: r.Sku ?? r.Id,
            name: r.Name,
            rate: Number(r.UnitPrice ?? 0) || undefined,
            qty: Number(r.QtyOnHand ?? 0),
            data: { stdRate: Number(r.UnitPrice ?? 0), stockOnHand: Number(r.QtyOnHand ?? 0), source: 'quickbooks' },
          });
          pulled++;
        }
      }
      if (entity === 'invoices') {
        const rows = await qboQuery(cfg, 'select * from Invoice maxresults 100');
        for (const r of rows) {
          const overdue = r.Balance != null && r.Balance > 0 && r.DueDate && new Date(r.DueDate) < new Date();
          await upsertEntityBySource(orgId, 'quickbooks', `invoice:${r.Id}`, {
            type: 'invoice',
            code: r.DocNumber,
            status: overdue ? 'overdue' : (r.Balance ?? 0) > 0 ? 'sent' : 'paid',
            amount: Number(r.TotalAmt ?? 0),
            date: r.TxnDate,
            data: { dueDate: r.DueDate ?? null, customer: r.CustomerRef?.name ?? null, balance: Number(r.Balance ?? 0), source: 'quickbooks' },
          });
          pulled++;
        }
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }

    await query(`update connectors set last_sync_at = now(), status = $2, last_error = $3 where id = $1`, [
      connectorId, errors.length && pulled === 0 ? 'error' : 'connected', errors[0] ?? null,
    ]);
    await audit(orgId, 'connector', 'quickbooks.sync', { metadata: { entity, pulled, errors: errors.length } });
    return { connectorId, entity, pulled, pushed: 0, errors, lastCursor: null };
  }

  async read(orgId: string, entity: SyncEntity): Promise<NormalizedRecord[]> {
    const typeMap: Partial<Record<SyncEntity, 'party' | 'item' | 'invoice'>> = {
      parties: 'party', ledgers: 'party', items: 'item', stock_items: 'item', invoices: 'invoice',
    };
    const entityType = typeMap[entity] ?? 'item';
    const rows = await query<{ id: string; code: string | null; name: string | null; amount: string | null; data: Record<string, unknown> }>(
      `select id, code, name, amount, data from entities where org_id = $1 and source = 'quickbooks' and type = $2 limit 200`,
      [orgId, entityType]
    );
    return rows.map((r) => ({
      type: entityType,
      sourceId: r.id,
      code: r.code ?? undefined,
      name: r.name ?? undefined,
      amount: r.amount ? Number(r.amount) : undefined,
      data: r.data,
    }));
  }

  async write(orgId: string, action: { type: string; payload: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (action.type !== 'invoice_push') {
      return { ok: false, error: `QuickBooks connector does not support '${action.type}' yet (invoice_push only)` };
    }
    const p = action.payload as { connectorId?: string; customerId?: string; customer?: string; invoiceNumber?: string; amount?: number; lineItem?: string; rate?: number; qty?: number };
    if (!p.connectorId) return { ok: false, error: 'connectorId missing in payload' };
    const row = await query<{ config: Record<string, unknown> }>('select config from connectors where id = $1', [p.connectorId]);
    const cfg = parseQboConfig(row[0]?.config);
    if (!cfg) return { ok: false, error: 'connector not configured' };

    // resolve the QBO customer
    let qboCustomerId: string | null = null;
    if (p.customerId) {
      const party = await query<{ source: string | null; source_id: string | null; code: string | null }>(
        'select source, source_id, code from entities where org_id = $1 and id = $2 limit 1',
        [orgId, p.customerId]
      );
      qboCustomerId = party[0]?.source === 'quickbooks' ? (party[0].source_id ?? party[0].code) : null;
    }
    if (!qboCustomerId) {
      const found = await query<{ source_id: string; code: string | null }>(
        `select source_id, code from entities where org_id = $1 and type='party' and source='quickbooks' and coalesce(name, data->>'name') ilike $2 limit 1`,
        [orgId, `%${p.customer ?? ''}%`]
      );
      qboCustomerId = found[0]?.source_id ?? found[0]?.code ?? null;
    }
    if (!qboCustomerId) return { ok: false, error: `Customer '${p.customer ?? p.customerId}' not found in QuickBooks — sync customers first` };

    try {
      const token = await accessToken(cfg);
      const res = await fetch(`${qboBaseUrl(cfg.environment)}/${cfg.realmId}/invoice?minorversion=65`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          CustomerRef: { value: qboCustomerId },
          DocNumber: p.invoiceNumber,
          Line: [{
            Amount: p.amount ?? (p.rate ?? 0) * (p.qty ?? 1),
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { Qty: p.qty ?? 1, UnitPrice: p.rate ?? p.amount ?? 0 },
            Description: p.lineItem ?? 'Services',
          }],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { Invoice?: { DocNumber?: string }; Fault?: { Error?: Array<{ Message?: string }> } };
      const fault = data.Fault?.Error?.[0]?.Message;
      if (!res.ok || !data.Invoice) return { ok: false, error: `QuickBooks invoice create failed: ${fault ?? res.status}` };
      await audit(orgId, 'connector', 'quickbooks.invoice_push', { metadata: { invoice: data.Invoice.DocNumber } });
      return { ok: true, result: { qboInvoice: data.Invoice.DocNumber } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async webhookHandler(event: WebhookEvent): Promise<WebhookResult> {
    const body = event.body as { eventNotifications?: Array<{ dataChangeEvent?: { entities?: Array<{ id?: string }> } }> };
    const entityId = body.eventNotifications?.[0]?.dataChangeEvent?.entities?.[0]?.id;
    return { ok: true, eventId: entityId ?? String(Date.now()), duplicate: false };
  }

  async health(orgId: string): Promise<{ status: 'connected' | 'error' | 'disconnected'; lastSyncAt?: string; lastError?: string }> {
    const rows = await query<{ status: string; last_sync_at: string | null; last_error: string | null; config: Record<string, unknown> }>(
      'select status, last_sync_at, last_error, config from connectors where org_id = $1 and type = $2 limit 1',
      [orgId, this.type]
    );
    const r = rows[0];
    if (!r) return { status: 'disconnected' };
    if (r.status === 'error') return { status: 'error', lastSyncAt: r.last_sync_at ?? undefined, lastError: r.last_error ?? undefined };
    if (!parseQboConfig(r.config)) return { status: 'disconnected', lastError: 'credentials missing' };
    return { status: r.status === 'connected' ? 'connected' : 'disconnected', lastSyncAt: r.last_sync_at ?? undefined };
  }
}
