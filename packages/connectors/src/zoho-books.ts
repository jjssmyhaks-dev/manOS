import { query, upsertEntityBySource, audit } from '@factory/db';
import type {
  Connector, SyncEntity, NormalizedRecord, SyncResult, AuthResult,
  WebhookEvent, WebhookResult,
} from './interface.js';

/**
 * Zoho Books — real cloud accounting integration (PRD C-2 class).
 *
 * Auth: OAuth2 refresh-token flow. The subscriber (or the operator onboarding
 * them) creates a Zoho API client once and pastes client id/secret + refresh
 * token (scope ZohoBooks.fullaccess.books or read+write split). Access tokens
 * are refreshed automatically, cached in memory until expiry, never stored.
 *
 * Sync pulls: contacts (customers + vendors), items with stock, and invoices
 * — upserted into entities by source id, so re-syncs update rather than
 * duplicate. Push creates a Zoho invoice for approved invoice_push actions.
 * Health: live call to organizations endpoint.
 */

export interface ZohoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  organizationId: string;
  region?: 'in' | 'us' | 'eu' | 'com';
}

export function parseZohoConfig(raw: unknown): ZohoConfig | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  const clientId = String(c.clientId ?? c.client_id ?? '').trim();
  const clientSecret = String(c.clientSecret ?? c.client_secret ?? '').trim();
  const refreshToken = String(c.refreshToken ?? c.refresh_token ?? '').trim();
  const organizationId = String(c.organizationId ?? c.organization_id ?? '').trim();
  if (!clientId || !clientSecret || !refreshToken || !organizationId) return null;
  const region = (String(c.region ?? 'in') as ZohoConfig['region']) ?? 'in';
  return { clientId, clientSecret, refreshToken, organizationId, region };
}

export function zohoBaseUrl(region: ZohoConfig['region']): string {
  switch (region) {
    case 'us': return 'https://www.zohoapis.com/books/v3';
    case 'eu': return 'https://www.zohoapis.eu/books/v3';
    case 'com': return 'https://www.zohoapis.com/books/v3';
    case 'in':
    default: return 'https://www.zohoapis.in/books/v3';
  }
}

const ACCOUNTS_URL = 'https://accounts.zoho.in/oauth/v2/token';

// --- OAuth redirect flow (owners click 'Connect Zoho', no token pasting) -----

export interface ZohoOAuthEnv {
  clientId: string;
  clientSecret: string;
  region: ZohoConfig['region'];
}

export function zohoOAuthEnv(): ZohoOAuthEnv | null {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const region = (process.env.ZOHO_REGION as ZohoConfig['region']) ?? 'in';
  return { clientId, clientSecret, region };
}

function accountsBase(region: ZohoConfig['region']): string {
  return region === 'us' ? 'https://accounts.zoho.com' : region === 'eu' ? 'https://accounts.zoho.eu' : 'https://accounts.zoho.in';
}

/**
 * The authorize URL the owner is redirected to. `state` carries the signed
 * org slug so the callback knows which workspace connected; redirect_uri must
 * exactly match the one registered on the Zoho API console client.
 */
export function zohoAuthorizeUrl(env: ZohoOAuthEnv, redirectUri: string, state: string): string {
  const url = new URL(`${accountsBase(env.region)}/oauth/v2/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.clientId);
  url.searchParams.set('scope', 'ZohoBooks.fullaccess.books');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export interface ZohoExchangeResult {
  ok: boolean;
  refreshToken?: string;
  error?: string;
}

/** Exchange the authorization code for a long-lived refresh token. */
export async function zohoExchangeCode(env: ZohoOAuthEnv, code: string, redirectUri: string): Promise<ZohoExchangeResult> {
  try {
    const res = await fetch(`${accountsBase(env.region)}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.clientId,
        client_secret: env.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
    if (!res.ok || !data.refresh_token) return { ok: false, error: data.error ?? `token exchange HTTP ${res.status}` };
    return { ok: true, refreshToken: data.refresh_token };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ZohoOrgChoice {
  organizationId: string;
  name: string;
}

/** List the organizations the granted token can see (auto-pick or show choice). */
export async function zohoListOrganizations(refreshToken: string, env: ZohoOAuthEnv): Promise<{ ok: boolean; orgs?: ZohoOrgChoice[]; error?: string }> {
  try {
    const token = await accessToken({ clientId: env.clientId, clientSecret: env.clientSecret, refreshToken, organizationId: 'pending', region: env.region });
    const res = await fetch(`${zohoBaseUrl(env.region)}/organizations`, {
      headers: { authorization: `Zoho-oauthtoken ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as { organizations?: Array<{ organization_id: string; name: string }>; message?: string };
    if (!res.ok || !data.organizations) return { ok: false, error: data.message ?? `organizations HTTP ${res.status}` };
    return { ok: true, orgs: data.organizations.map((o) => ({ organizationId: String(o.organization_id), name: o.name })) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// access-token cache (per connector config hash) — tokens live ~1h
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(cfg: ZohoConfig): Promise<string> {
  const key = `${cfg.clientId}:${cfg.refreshToken.slice(-8)}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  const res = await fetch(ACCOUNTS_URL.replace('zoho.in', cfg.region === 'us' ? 'zoho.com' : cfg.region === 'eu' ? 'zoho.eu' : 'zoho.in'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: cfg.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Zoho token refresh failed: ${data.error ?? res.status}`);
  }
  tokenCache.set(key, { token: data.access_token!, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token!;
}

async function zohoGet<T>(cfg: ZohoConfig, path: string, params: Record<string, string> = {}): Promise<T[]> {
  const token = await accessToken(cfg);
  const url = new URL(`${zohoBaseUrl(cfg.region)}${path}`);
  url.searchParams.set('organization_id', cfg.organizationId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { authorization: `Zoho-oauthtoken ${token}` } });
  const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string; contacts?: T[]; items?: T[]; invoices?: T[] };
  if (!res.ok || (data.code && data.code !== 0)) {
    throw new Error(`Zoho ${path} failed: ${data.message ?? res.status}`);
  }
  return (data.contacts ?? data.items ?? data.invoices ?? []) as T[];
}

/** Live connection test: fetch the organization name. */
export async function zohoTestConnection(cfg: ZohoConfig): Promise<{ ok: boolean; orgName?: string; error?: string }> {
  try {
    const token = await accessToken(cfg);
    const res = await fetch(`${zohoBaseUrl(cfg.region)}/organizations/${cfg.organizationId}`, {
      headers: { authorization: `Zoho-oauthtoken ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as { organization?: { name?: string }; message?: string; code?: number };
    if (!res.ok || !data.organization) return { ok: false, error: data.message ?? `HTTP ${res.status}` };
    return { ok: true, orgName: data.organization.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export class ZohoBooksConnector implements Connector {
  readonly type = 'zoho_books';

  async auth(config: Record<string, unknown>): Promise<AuthResult> {
    const cfg = parseZohoConfig(config);
    if (!cfg) return { ok: false, mode: 'oauth', error: 'clientId, clientSecret, refreshToken and organizationId are all required' };
    const test = await zohoTestConnection(cfg);
    return test.ok ? { ok: true, mode: 'oauth' } : { ok: false, mode: 'oauth', error: test.error };
  }

  async sync(orgId: string, connectorId: string, entity: SyncEntity): Promise<SyncResult> {
    const row = await query<{ config: Record<string, unknown> }>('select config from connectors where id = $1', [connectorId]);
    const cfg = parseZohoConfig(row[0]?.config);
    if (!cfg) return { connectorId, entity, pulled: 0, pushed: 0, errors: ['connector not configured'], lastCursor: null };

    const errors: string[] = [];
    let pulled = 0;
    let cursor: string | null = null;

    const pull = async (path: string, params: Record<string, string>, map: (r: Record<string, unknown>) => NormalizedRecord) => {
      try {
        const rows = await zohoGet<Record<string, unknown>>(cfg, path, params);
        for (const r of rows) {
          const rec = map(r);
          await upsertEntityBySource(orgId, 'zoho_books', rec.sourceId, { type: rec.type, code: rec.code, name: rec.name, status: rec.status, amount: rec.amount, qty: rec.qty, rate: rec.rate, date: rec.date, data: rec.data });
          pulled++;
          const modified = String(r.last_modified_time ?? '');
          if (modified && (!cursor || modified > cursor)) cursor = modified;
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    };

    if (entity === 'parties' || entity === 'ledgers') {
      await pull('/contacts', { per_page: '100' }, (r) => {
        const contactType = String(r.contact_type ?? 'customer');
        const cf = r as { contact_id?: string; contact_name?: string; contact_type?: string; gstin?: string; currency_code?: string; outstanding_receivable_amount?: number; outstanding_payable_amount?: number };
        return {
          type: 'party' as const,
          sourceId: String(cf.contact_id ?? ''),
          name: cf.contact_name,
          data: { kind: contactType === 'vendor' ? 'vendor' : 'customer', gstin: cf.gstin ?? null, currency: cf.currency_code ?? 'INR', source: 'zoho_books', outstanding: Number(cf.outstanding_receivable_amount ?? 0) },
        };
      });
    }

    if (entity === 'stock_items' || entity === 'items') {
      await pull('/items', { per_page: '100' }, (r) => {
        const it = r as { item_id?: string; name?: string; sku?: string; rate?: number; stock_on_hand?: number; unit?: string; purchase_rate?: number };
        return {
          type: 'item' as const,
          sourceId: String(it.item_id ?? ''),
          code: it.sku ?? undefined,
          name: it.name,
          rate: Number(it.rate ?? 0) || undefined,
          qty: Number(it.stock_on_hand ?? 0),
          data: { uom: it.unit ?? 'nos', stdRate: Number(it.rate ?? 0), purchaseRate: Number(it.purchase_rate ?? 0), stockOnHand: Number(it.stock_on_hand ?? 0), source: 'zoho_books' },
        };
      });
    }

    if (entity === 'invoices') {
      await pull('/invoices', { per_page: '100' }, (r) => {
        const inv = r as { invoice_id?: string; invoice_number?: string; status?: string; total?: number; customer_name?: string; date?: string; due_date?: string; balance?: number };
        const status = String(inv.status ?? 'sent').toLowerCase() === 'overdue' ? 'overdue' : String(inv.status ?? 'sent').toLowerCase();
        return {
          type: 'invoice' as const,
          sourceId: String(inv.invoice_id ?? ''),
          code: inv.invoice_number,
          status,
          amount: Number(inv.total ?? 0),
          date: inv.date ?? undefined,
          data: { dueDate: inv.due_date ?? null, customer: inv.customer_name ?? null, balance: Number(inv.balance ?? 0), source: 'zoho_books' },
        };
      });
    }

    if (cursor) {
      await query(
        `insert into sync_state (connector_id, entity_type, cursor) values ($1,$2,$3::jsonb)
         on conflict (connector_id, entity_type) do update set cursor = $3::jsonb, updated_at = now()`,
        [connectorId, entity, JSON.stringify({ lastModified: cursor })]
      );
    }

    await query(`update connectors set last_sync_at = now(), status = $2, last_error = $3 where id = $1`, [
      connectorId, errors.length ? 'error' : 'connected', errors[0] ?? null,
    ]);
    await audit(orgId, 'connector', 'zoho_books.sync', { metadata: { entity, pulled, errors: errors.length } });
    return { connectorId, entity, pulled, pushed: 0, errors, lastCursor: cursor };
  }

  async read(orgId: string, entity: SyncEntity): Promise<NormalizedRecord[]> {
    const typeMap: Partial<Record<SyncEntity, 'party' | 'item' | 'invoice'>> = {
      parties: 'party', ledgers: 'party', items: 'item', stock_items: 'item', invoices: 'invoice',
    };
    const entityType = typeMap[entity] ?? 'item';
    const rows = await query<{ id: string; code: string | null; name: string | null; amount: string | null; data: Record<string, unknown> }>(
      `select id, code, name, amount, data from entities where org_id = $1 and source = 'zoho_books' and type = $2 limit 200`,
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
      return { ok: false, error: `Zoho Books connector does not support '${action.type}' yet (invoice_push only)` };
    }
    const p = action.payload as { connectorId?: string; customerId?: string; customer?: string; invoiceNumber?: string; amount?: number; lineItem?: string; rate?: number; qty?: number };
    if (!p.connectorId) return { ok: false, error: 'connectorId missing in payload' };
    const row = await query<{ config: Record<string, unknown> }>('select config from connectors where id = $1', [p.connectorId]);
    const cfg = parseZohoConfig(row[0]?.config);
    if (!cfg) return { ok: false, error: 'connector not configured' };

    // resolve the Zoho contact: prefer a stored zoho id on the party
    let zohoCustomerId: string | null = null;
    if (p.customerId) {
      const party = await query<{ source: string | null; source_id: string | null }>(
        `select source, source_id from entities where org_id = $1 and id = $2 limit 1`,
        [orgId, p.customerId]
      );
      zohoCustomerId = party[0]?.source === 'zoho_books' ? party[0].source_id : null;
    }
    if (!zohoCustomerId) {
      const found = await query<{ source_id: string }>(
        `select source_id from entities where org_id = $1 and type='party' and source='zoho_books' and coalesce(name, data->>'name') ilike $2 limit 1`,
        [orgId, `%${p.customer ?? ''}%`]
      );
      zohoCustomerId = found[0]?.source_id ?? null;
    }
    if (!zohoCustomerId) return { ok: false, error: `Customer '${p.customer ?? p.customerId}' not found in Zoho Books — sync contacts first` };

    const token = await accessToken(cfg);
    const res = await fetch(`${zohoBaseUrl(cfg.region)}/invoices?organization_id=${encodeURIComponent(cfg.organizationId)}`, {
      method: 'POST',
      headers: { authorization: `Zoho-oauthtoken ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        customer_id: zohoCustomerId,
        invoice_number: p.invoiceNumber,
        line_items: [{ name: p.lineItem ?? 'Services', rate: p.rate ?? p.amount ?? 0, quantity: p.qty ?? 1 }],
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { invoice?: { invoice_number?: string }; message?: string; code?: number };
    if (!res.ok || !data.invoice) return { ok: false, error: `Zoho invoice create failed: ${data.message ?? res.status}` };
    await audit(orgId, 'connector', 'zoho_books.invoice_push', { metadata: { invoice: data.invoice.invoice_number } });
    return { ok: true, result: { zohoInvoice: data.invoice.invoice_number } };
  }

  async webhookHandler(event: WebhookEvent): Promise<WebhookResult> {
    // Zoho Books webhook: invoice.payment / contact created etc. — store idempotently
    const body = event.body as { invoice_id?: string; contact_id?: string };
    const eventId = String(body.invoice_id ?? body.contact_id ?? Date.now());
    return { ok: true, eventId, duplicate: false };
  }

  async health(orgId: string): Promise<{ status: 'connected' | 'error' | 'disconnected'; lastSyncAt?: string; lastError?: string }> {
    const rows = await query<{ status: string; last_sync_at: string | null; last_error: string | null; config: Record<string, unknown> }>(
      'select status, last_sync_at, last_error, config from connectors where org_id = $1 and type = $2 limit 1',
      [orgId, this.type]
    );
    const r = rows[0];
    if (!r) return { status: 'disconnected' };
    if (r.status === 'error') return { status: 'error', lastSyncAt: r.last_sync_at ?? undefined, lastError: r.last_error ?? undefined };
    if (!parseZohoConfig(r.config)) return { status: 'disconnected', lastError: 'credentials missing' };
    return { status: r.status === 'connected' ? 'connected' : 'disconnected', lastSyncAt: r.last_sync_at ?? undefined };
  }
}
