import { signup } from '@/lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/auth/signup — creates the workspace + owner and starts a session. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string; company?: string };
  if (!body.email || !body.password) {
    return Response.json({ error: 'Email and password are required.' }, { status: 400 });
  }
  const res = await signup({ email: body.email, password: body.password, name: body.name, company: body.company });
  return Response.json(res, { status: res.ok ? 200 : 400 });
}
