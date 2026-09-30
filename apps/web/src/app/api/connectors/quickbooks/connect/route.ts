import { getSession } from '@/lib/session';
import { cookies } from 'next/headers';
import { qboOAuthEnv, qboAuthorizeUrl } from '@factory/connectors';
import crypto from 'node:crypto';

export const runtime = 'nodejs';

/** GET /api/connectors/quickbooks/connect — kicks off the Intuit OAuth dance. */
export async function GET(req: Request) {
  const env = qboOAuthEnv();
  if (!env) {
    return Response.json(
      { error: 'QuickBooks OAuth is not configured on this deployment — the operator sets QBO_CLIENT_ID and QBO_CLIENT_SECRET.' },
      { status: 501 }
    );
  }
  const s = await getSession();
  if (s.orgId === 'none') return Response.json({ error: 'no workspace' }, { status: 400 });

  const nonce = crypto.randomBytes(12).toString('hex');
  const jar = await cookies();
  jar.set('qbo_oauth_nonce', nonce, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 });

  const url = new URL(req.url);
  const redirectUri = `${url.origin}/api/connectors/quickbooks/callback`;
  return Response.redirect(qboAuthorizeUrl(env, redirectUri, `${s.orgSlug}:${nonce}`), 302);
}
