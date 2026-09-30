import { getSessionUser } from '@/lib/auth';
import { query } from '@factory/db';

export const runtime = 'nodejs';

/** GET /api/auth/me — the signed-in user + their workspace (user: null when demo/anon). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ user: null });

  const rows = await query<{ name: string; slug: string; vertical: string }>(
    'select name, slug, vertical from organizations where id = $1 limit 1',
    [user.orgId]
  );
  const org = rows[0] ?? null;

  return Response.json({
    user: { userId: user.userId, email: user.email, name: user.name, role: user.role },
    org: org ? { name: org.name, slug: org.slug, vertical: org.vertical } : null,
  });
}
