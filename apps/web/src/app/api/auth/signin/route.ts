import { signin } from '@/lib/auth';

export const runtime = 'nodejs';

/** POST /api/auth/signin — verify credentials and start a session. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!body.email || !body.password) {
    return Response.json({ error: 'Email and password are required.' }, { status: 400 });
  }
  const res = await signin(body.email, body.password);
  return Response.json(res, { status: res.ok ? 200 : 401 });
}
