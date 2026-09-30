import { signout } from '@/lib/auth';

export const runtime = 'nodejs';

/** POST /api/auth/signout — kill the session server-side + clear the cookie. */
export async function POST() {
  await signout();
  return Response.json({ ok: true });
}
