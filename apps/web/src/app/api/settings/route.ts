import { query, audit } from '@factory/db';
import { setPolicy, getPolicyDecision } from '@factory/core';
import { listFacts, addFact, setFactStatus } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/** GET /api/settings — policies + org facts + AI model config (key masked). */
export async function GET() {
  const s = await getSession();
  const policies = await query('select action_type, decision from policies where org_id=$1 order by action_type', [s.orgId]);
  const facts = await listFacts(s.orgId);
  const ai = await query<{ provider: string; api_key: string | null; model_route: string }>(
    'select provider, api_key, model_route from ai_config where org_id=$1 limit 1',
    [s.orgId]
  );
  const envKey = Boolean(process.env.OPENROUTER_API_KEY);
  const key = ai[0]?.api_key ?? null;
  return Response.json({
    policies,
    facts,
    ai: {
      provider: ai[0]?.provider ?? 'openrouter',
      model_route: ai[0]?.model_route ?? 'default',
      has_org_key: Boolean(key),
      key_masked: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
      has_env_key: envKey,
      effective: key ? 'org-key (prod)' : envKey ? 'env-key (prod)' : 'mock (dev)',
    },
  });
}

/** POST /api/settings — update policy decision, AI config, or manage facts. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as {
    action: 'set_policy' | 'add_fact' | 'archive_fact' | 'set_ai_config' | 'clear_ai_key';
    actionType?: string;
    decision?: 'auto' | 'ask' | 'deny';
    fact?: string;
    factId?: string;
    apiKey?: string;
    modelRoute?: 'default' | 'budget';
  };

  if (body.action === 'set_policy' && body.actionType && body.decision) {
    await setPolicy(s.orgId, body.actionType, body.decision);
    return Response.json({ ok: true });
  }

  if (body.action === 'set_ai_config') {
    const key = body.apiKey?.trim();
    if (key !== undefined && key.length > 0 && !key.startsWith('sk-or-')) {
      return Response.json({ error: 'OpenRouter keys start with sk-or-' }, { status: 400 });
    }
    const route = body.modelRoute === 'budget' ? 'budget' : 'default';
    await query(
      `insert into ai_config (org_id, provider, api_key, model_route)
       values ($1,'openrouter',$2,$3)
       on conflict (org_id) do update set
         api_key = coalesce(excluded.api_key, ai_config.api_key),
         model_route = excluded.model_route,
         updated_at = now()`,
      [s.orgId, key && key.length > 0 ? key : null, route]
    );
    await audit(s.orgId, `user:${s.userName}`, 'settings.ai_config', {
      metadata: { route, key_set: Boolean(key) },
    });
    return Response.json({ ok: true });
  }

  if (body.action === 'clear_ai_key') {
    await query(`update ai_config set api_key = null, updated_at = now() where org_id = $1`, [s.orgId]);
    await audit(s.orgId, `user:${s.userName}`, 'settings.ai_config', { metadata: { key_cleared: true } });
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
