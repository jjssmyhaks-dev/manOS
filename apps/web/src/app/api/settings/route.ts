import { query, audit } from '@factory/db';
import { setPolicy, getPolicyDecision } from '@factory/core';
import { listFacts, addFact, setFactStatus, getNotifySettings, saveNotifySettings, dispatchQueuedNotifications, ROUTE_LABELS, platformHasAiKey } from '@factory/agents';
import { whatsappEnvConfig } from '@factory/connectors';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/** GET /api/settings — policies + org facts + AI model choice (platform key; no user keys). */
export async function GET() {
  const s = await getSession();
  const policies = await query('select action_type, decision from policies where org_id=$1 order by action_type', [s.orgId]);
  const facts = await listFacts(s.orgId);
  const ai = await query<{ model_route: string }>(
    'select model_route from ai_config where org_id=$1 limit 1',
    [s.orgId]
  );
  const notify = await getNotifySettings(s.orgId);
  const wa = whatsappEnvConfig();
  const platform = platformHasAiKey();
  return Response.json({
    policies,
    facts,
    notify: {
      owner_phone: notify.ownerPhone,
      auto_send: notify.autoSend,
      mode: wa.echo ? 'echo' : 'live',
      phone_number_id_set: Boolean(wa.phoneNumberId),
    },
    ai: {
      platform,
      model_route: ai[0]?.model_route ?? 'default',
      effective: platform ? 'Smart AI included' : 'mock (dev — platform key not configured)',
      options: Object.entries(ROUTE_LABELS).map(([key, v]) => ({ key, ...v })),
    },
  });
}

/** POST /api/settings — update policy decision, AI config, or manage facts. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as {
    action: 'set_policy' | 'add_fact' | 'archive_fact' | 'set_model_route' | 'save_notify' | 'dispatch_now';
    actionType?: string;
    decision?: 'auto' | 'ask' | 'deny';
    fact?: string;
    factId?: string;
    modelRoute?: 'default' | 'budget';
    ownerPhone?: string | null;
    autoSend?: boolean;
  };

  if (body.action === 'save_notify') {
    // normalise to bare digits (E.164 without +) for the Cloud API
    const digits = body.ownerPhone ? body.ownerPhone.replace(/[^0-9]/g, '') : null;
    if (digits && (digits.length < 10 || digits.length > 15)) {
      return Response.json({ error: 'Phone must be a valid number with country code, e.g. 919812345678' }, { status: 400 });
    }
    await saveNotifySettings(s.orgId, digits, Boolean(body.autoSend));
    await audit(s.orgId, `user:${s.userName}`, 'settings.notify', { metadata: { auto_send: Boolean(body.autoSend), phone_set: Boolean(digits) } });
    return Response.json({ ok: true });
  }

  if (body.action === 'dispatch_now') {
    const res = await dispatchQueuedNotifications(s.orgId);
    return Response.json({ ok: true, ...res });
  }

  if (body.action === 'set_policy' && body.actionType && body.decision) {
    await setPolicy(s.orgId, body.actionType, body.decision);
    return Response.json({ ok: true });
  }

  // subscriber chooses the model class only — the AI key stays platform-side
  if (body.action === 'set_model_route') {
    const route = body.modelRoute === 'budget' ? 'budget' : 'default';
    await query(
      `insert into ai_config (org_id, provider, model_route)
       values ($1,'openrouter',$2)
       on conflict (org_id) do update set
         model_route = excluded.model_route,
         updated_at = now()`,
      [s.orgId, route]
    );
    await audit(s.orgId, `user:${s.userName}`, 'settings.model_route', {
      metadata: { route },
    });
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
