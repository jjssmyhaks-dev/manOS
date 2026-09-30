import { query, audit } from '@factory/db';
import { qboOAuthEnv, qboExchangeCode } from '@factory/connectors';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/connectors/quickbooks/callback — Intuit redirects here with
 * ?code=&state=&realmId=. Same nonce-cookie pattern as the Zoho callback;
 * realmId comes from Intuit's redirect (the company the owner picked).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const back = (msg: string, ok: boolean) =>
    Response.redirect(`${origin}/connectors?qbo=${ok ? 'ok' : 'error'}&msg=${encodeURIComponent(msg)}`, 302);

  const env = qboOAuthEnv();
  if (!env) return back('QuickBooks OAuth is not configured on this deployment', false);

  const error = url.searchParams.get('error');
  if (error) return back(`Intuit consent was declined or failed: ${error}`, false);

  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  const state = url.searchParams.get('state') ?? '';
  const [slug, nonce] = state.split(':');
  const jar = await cookies();
  const expected = jar.get('qbo_oauth_nonce')?.value;
  if (!code || !realmId || !slug || !nonce || !expected || nonce !== expected) {
    return back('This connection link expired or was already used — please click Connect QuickBooks again.', false);
  }
  jar.delete('qbo_oauth_nonce');

  const exchange = await qboExchangeCode(env, code, `${origin}/api/connectors/quickbooks/callback`);
  if (!exchange.ok || !exchange.refreshToken) return back(`QuickBooks token exchange failed: ${exchange.error ?? 'unknown'}`, false);

  const orgRow = await query<{ id: string }>('select id from organizations where slug = $1 limit 1', [slug]);
  if (!orgRow[0]) return back('Workspace not found — please sign in again.', false);

  await query(
    `insert into connectors (org_id, type, status, config) values ($1,'quickbooks','registered',$2::jsonb)
     on conflict (org_id, type) do update set config = $2::jsonb, status = 'registered', last_error = null`,
    [orgRow[0].id, JSON.stringify({ clientId: env.clientId, clientSecret: env.clientSecret, refreshToken: exchange.refreshToken, realmId, environment: env.environment })]
  );
  await audit(orgRow[0].id, 'oauth:quickbooks', 'connector.configured', { metadata: { type: 'quickbooks', realmId, via: 'oauth' } });

  return back(`QuickBooks connected (company ${realmId}). Run "Sync now" to pull your data.`, true);
}
