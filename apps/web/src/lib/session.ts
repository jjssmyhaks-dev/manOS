import { cookies } from 'next/headers';
import { query, seedDemoData } from '@factory/db';

/**
 * Dev session (PRD F1 workspace/onboarding): in this build the auth boundary
 * is a demo org selector cookie; production swaps to Supabase Auth (email/
 * phone OTP) without touching call sites — every data path takes orgId.
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
