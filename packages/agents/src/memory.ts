import { query } from '@factory/db';

/**
 * Per-org memory (PRD §6): facts stored as reviewable records, not hidden
 * prompt state. The agent can add facts; owners can edit/delete from settings.
 */

export interface OrgFact {
  id: string;
  fact: string;
  status: string;
  source: string;
}

export async function addFact(orgId: string, fact: string, source = 'agent'): Promise<string> {
  const rows = await query<{ id: string }>(
    `insert into org_facts (org_id, fact, source) values ($1,$2,$3) returning id`,
    [orgId, fact.slice(0, 500), source]
  );
  return rows[0]!.id;
}

export async function listFacts(orgId: string, includeArchived = false): Promise<OrgFact[]> {
  const rows = await query<{ id: string; fact: string; status: string; source: string }>(
    `select id, fact, status, source from org_facts where org_id=$1 ${includeArchived ? '' : "and status != 'archived'"} order by created_at desc limit 100`,
    [orgId]
  );
  return rows;
}

export async function setFactStatus(orgId: string, id: string, status: 'active' | 'review' | 'archived'): Promise<void> {
  await query('update org_facts set status=$3 where org_id=$1 and id=$2', [orgId, id, status]);
}
