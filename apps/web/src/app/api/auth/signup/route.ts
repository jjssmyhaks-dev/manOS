import { signup } from '@/lib/auth';
import { limit, clientKey } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/auth/signup — creates the workspace + owner and starts a session.
 * Rate-limited per IP: signup seeds a full sample workspace, so unbounded
 * calls are both a compute and storage abuse vector.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string; company?: string };
  if (!body.email || !body.password) {
    return Response.json({ error: 'Email and password are required.' }, { status: 400 });
  }
  const rl = limit(clientKey(req), 5, 3600);
  if (!rl.ok) {
    return Response.json({ error: `Too many signups from this address — try again in ${Math.ceil(rl.retryAfterSec / 60)} min.` }, { status: 429 });
  }
  const res = await signup({ email: body.email, password: body.password, name: body.name, company: body.company });
  return Response.json(res, { status: res.ok ? 200 : 400 });
}
