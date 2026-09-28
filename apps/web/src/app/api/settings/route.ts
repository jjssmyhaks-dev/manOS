import { query } from '@factory/db';
import { setPolicy, getPolicyDecision } from '@factory/core';
import { listFacts, addFact, setFactStatus } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/** GET /api/settings — policies + org facts. */
export async function GET() {
  const s = await getSession();
  const policies = await query('select action_type, decision from policies where org_id=$1 order by action_type', [s.orgId]);
  const facts = await listFacts(s.orgId);
  return Response.json({ policies, facts });
}

/** POST /api/settings — update policy decision or manage facts. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as {
    action: 'set_policy' | 'add_fact' | 'archive_fact';
    actionType?: string;
    decision?: 'auto' | 'ask' | 'deny';
    fact?: string;
    factId?: string;
  };

  if (body.action === 'set_policy' && body.actionType && body.decision) {
    await setPolicy(s.orgId, body.actionType, body.decision);
    return Response.json({ ok: true });
  }
  if (body.action === 'add_fact' && body.fact) {
    const id = await addFact(s.orgId, body.fact, 'user');
    return Response.json({ ok: true, id });
  }
  if (body.action === 'archive_fact' && body.factId) {
    await setFactStatus(s.orgId, body.factId, 'archived');
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'unknown action' }, { status: 400 });
}

/** PUT — read a single policy decision (helper for UI). */
export async function PUT(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as { actionType: string };
  const decision = await getPolicyDecision(s.orgId, body.actionType);
  return Response.json({ decision });
}
