import { signin, pruneUserSessions } from '@/lib/auth';
import { limit, clientKey } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * POST /api/auth/signin — verify credentials and start a session.
 * Rate-limited per IP+email (brute-force backstop); successful signins prune
 * the account's stale sessions so the sessions table cannot grow unbounded.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!body.email || !body.password) {
    return Response.json({ error: 'Email and password are required.' }, { status: 400 });
  }
  const rl = limit(clientKey(req, body.email.trim().toLowerCase()), 10, 300);
  if (!rl.ok) {
    return Response.json({ error: `Too many attempts — try again in ${rl.retryAfterSec}s.` }, { status: 429 });
  }
  const res = await signin(body.email, body.password);
  if (res.ok && res.userId) await pruneUserSessions(res.userId);
  return Response.json(res, { status: res.ok ? 200 : 401 });
}
