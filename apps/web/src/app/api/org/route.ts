import { seedDemoData, SEED_ORGS } from '@factory/db';
import { getSession, listDemoOrgs, ORG_COOKIE } from '@/lib/session';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** GET /api/org — list demo orgs + current session. */
export async function GET() {
  const orgs = await listDemoOrgs();
  const s = await getSession();
  return Response.json({ orgs, session: s });
}

/** POST /api/org — create/seed a demo org or switch org cookie. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action: 'seed' | 'switch'; slug?: string };
  if (body.action === 'seed') {
    const slug = body.slug && SEED_ORGS.some((o) => o.slug === body.slug) ? body.slug : 'precision-metalworks';
    const { orgId, counts } = await seedDemoData(slug);
    return Response.json({ ok: true, orgId, counts });
  }
  if (body.action === 'switch' && body.slug) {
    const jar = await cookies();
    jar.set(ORG_COOKIE, body.slug, { httpOnly: false, sameSite: 'lax', path: '/' });
    return Response.json({ ok: true, slug: body.slug });
  }
  return Response.json({ error: 'unknown action' }, { status: 400 });
}
