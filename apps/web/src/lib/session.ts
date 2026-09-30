import { cookies } from 'next/headers';
import { query, seedDemoData } from '@factory/db';
import { getSessionUser } from '@/lib/auth';

/**
 * Session resolution: a signed-in user's workspace wins; without a session
 * the demo org-selector cookie keeps the no-signup demo working (PRD F1).
 * Every data path takes orgId, so both paths share all call sites.
 */

export interface Session {
  orgId: string;
  orgName: string;
  orgSlug: string;
  vertical: string;
  role: string;
  userName: string;
}

export const ORG_COOKIE = 'factory_org';

/** List seeded demo orgs, seeding on first access. */
export async function listDemoOrgs(): Promise<Array<{ id: string; name: string; slug: string; vertical: string }>> {
  let rows = await query<{ id: string; name: string; slug: string; vertical: string }>(
    'select id, name, slug, vertical from organizations order by created_at asc'
  );
  if (rows.length === 0) {
    await seedDemoData('precision-metalworks');
    rows = await query('select id, name, slug, vertical from organizations order by created_at asc');
  }
  return rows;
}

export async function getSession(): Promise<Session> {
  // a signed-in user is pinned to their own workspace
  const user = await getSessionUser();
  if (user) {
    const rows = await query<{ name: string; slug: string; vertical: string }>(
      'select name, slug, vertical from organizations where id = $1 limit 1',
      [user.orgId]
    );
    if (rows[0]) {
      return {
        orgId: user.orgId,
        orgName: rows[0].name,
        orgSlug: rows[0].slug,
        vertical: rows[0].vertical,
        role: user.role,
        userName: user.name ?? user.email,
      };
    }
  }

  // demo path: org-selector cookie
  const orgs = await listDemoOrgs();
  const jar = await cookies();
  const slug = jar.get(ORG_COOKIE)?.value;
  const org = orgs.find((o) => o.slug === slug) ?? orgs[0];
  if (!org) {
    return { orgId: 'none', orgName: 'No org', orgSlug: 'none', vertical: 'fabrication', role: 'owner', userName: 'Owner' };
  }
  return {
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    vertical: org.vertical,
    role: 'owner',
    userName: 'Owner',
  };
}
