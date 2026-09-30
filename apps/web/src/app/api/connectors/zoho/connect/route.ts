import { getSession, ORG_COOKIE } from '@/lib/session';
import { cookies } from 'next/headers';
import { zohoOAuthEnv, zohoAuthorizeUrl } from '@factory/connectors';
import crypto from 'node:crypto';

export const runtime = 'nodejs';

/**
 * GET /api/connectors/zoho/connect — kicks off the OAuth dance.
 * state = orgSlug:nonce (nonce checked at the callback to prevent forgery;
 * the slug picks the workspace server-side, never from the browser later).
 */
export async function GET(req: Request) {
  const env = zohoOAuthEnv();
  if (!env) {
    return Response.json(
      { error: 'Zoho OAuth is not configured on this deployment — the operator sets ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET.' },
      { status: 501 }
    );
  }
  const s = await getSession();
  if (s.orgId === 'none') return Response.json({ error: 'no workspace' }, { status: 400 });

  const nonce = crypto.randomBytes(12).toString('hex');
  const jar = await cookies();
  jar.set('zoho_oauth_nonce', nonce, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 });
  const slug = await (async () => {
    void ORG_COOKIE;
    return s.orgSlug;
  })();

  const url = new URL(req.url);
  const redirectUri = `${url.origin}/api/connectors/zoho/callback`;
  return Response.redirect(zohoAuthorizeUrl(env, redirectUri, `${slug}:${nonce}`), 302);
}
