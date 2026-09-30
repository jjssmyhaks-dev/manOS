import { query, audit } from '@factory/db';
import { zohoOAuthEnv, zohoExchangeCode, zohoListOrganizations } from '@factory/connectors';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/connectors/zoho/callback — Zoho redirects here after consent.
 * Exchanges the code for a refresh token, auto-picks the organization (or
 * guides the owner if several), saves the connector, and redirects back to
 * the Connectors page with a result flag. Secrets live only in the DB row.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const back = (msg: string, ok: boolean) =>
    Response.redirect(`${origin}/connectors?zoho=${ok ? 'ok' : 'error'}&msg=${encodeURIComponent(msg)}`, 302);

  const env = zohoOAuthEnv();
  if (!env) return back('Zoho OAuth is not configured on this deployment', false);

  const error = url.searchParams.get('error');
  if (error) return back(`Zoho consent was declined or failed: ${error}`, false);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const [slug, nonce] = state.split(':');
  const jar = await cookies();
  const expected = jar.get('zoho_oauth_nonce')?.value;
  if (!code || !slug || !nonce || !expected || nonce !== expected) {
    return back('This connection link expired or was already used — please click Connect Zoho again.', false);
  }
  jar.delete('zoho_oauth_nonce');

  const exchange = await zohoExchangeCode(env, code, `${origin}/api/connectors/zoho/callback`);
  if (!exchange.ok || !exchange.refreshToken) return back(`Zoho token exchange failed: ${exchange.error ?? 'unknown'}`, false);

  const orgs = await zohoListOrganizations(exchange.refreshToken, env);
  if (!orgs.ok || !orgs.orgs?.length) return back(`Connected to Zoho, but no organisations are visible: ${orgs.error ?? 'none found'}`, false);

  const orgRow = await query<{ id: string }>('select id from organizations where slug = $1 limit 1', [slug]);
  if (!orgRow[0]) return back('Workspace not found — please sign in again.', false);
  const orgId = orgRow[0].id;

  const chosen = orgs.orgs[0]!;
  await query(
    `insert into connectors (org_id, type, status, config) values ($1,'zoho_books','registered',$2::jsonb)
     on conflict (org_id, type) do update set config = $2::jsonb, status = 'registered', last_error = null`,
    [orgId, JSON.stringify({ clientId: env.clientId, clientSecret: env.clientSecret, refreshToken: exchange.refreshToken, organizationId: chosen.organizationId, region: env.region, orgName: chosen.name })]
  );
  await audit(orgId, 'oauth:zoho', 'connector.configured', { metadata: { type: 'zoho_books', org: chosen.name, via: 'oauth' } });

  const extra = orgs.orgs.length > 1 ? ` (multiple Zoho organisations visible — using "${chosen.name}"; tell us if that's the wrong one)` : '';
  return back(`Zoho Books connected: ${chosen.name}${extra}`, true);
}
