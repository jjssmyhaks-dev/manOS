import { generateAllPilotDigests, pilotDigestText, deliverPilotDigest } from '@factory/agents';
import { audit, query } from '@factory/db';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/jobs/pilot-digest — weekly pilot feedback digest (operator-facing;
 * sent to US, never the owner): usage stats, override-rate trend and top
 * correction themes per org — the case-study raw material.
 *
 * Delivery, per org: rendered WhatsApp text queued into notifications under
 * template 'pilot_digest' (durable record + dispatchable), then actively
 * delivered to the operator — WhatsApp to OPERATOR_WHATSAPP (live or echo in
 * dev) and email to OPERATOR_EMAIL via Resend when RESEND_API_KEY is set.
 * Also registered in vercel.json as a Monday cron; the nightly cron calls the
 * same pipeline on Mondays. Guarded by CRON_SECRET when set.
 */
async function guard(req: Request): Promise<Response | null> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return null;
}

const DELIVERY_ENV =
  'OPERATOR_WHATSAPP and/or OPERATOR_EMAIL (+RESEND_API_KEY) — operator channels, platform-side';

export async function POST(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;

  const digests = await generateAllPilotDigests();
  let delivered: Awaited<ReturnType<typeof deliverPilotDigest>> | null = null;

  for (const r of digests) {
    const text = pilotDigestText(r);
    // durable record first (audit trail + the /pilot page reads this template)
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'pilot_digest',$3,'queued')`,
      [r.orgId, 'operator', text]
    );
    // active delivery for the freshest report only — one WhatsApp/email with
    // every org's section beats N pings; generateAllPilotDigests is ordered,
    // so per-org queueing + one combined push is the right shape
    if (r === digests[0]) {
      const combined = digests.length > 1 ? digests.map(pilotDigestText).join('\n\n———\n\n') : text;
      delivered = await deliverPilotDigest(combined).catch(() => null);
    }
  }
  await audit(digests[0]?.orgId ?? '00000000-0000-0000-0000-000000000000', 'system', 'jobs.pilot_digest', {
    metadata: { orgs: digests.length, delivery: delivered ?? null },
  });

  return Response.json({
    ok: true,
    orgs: digests.length,
    digests,
    delivery: delivered ?? { whatsapp: 'skipped', email: 'skipped', note: `set ${DELIVERY_ENV}` },
  });
}

/** GET — a dry-run preview of the current report without queuing or sending. */
export async function GET(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;
  const digests = await generateAllPilotDigests();
  return Response.json({ ok: true, orgs: digests.length, preview: digests.map(pilotDigestText), deliveryEnv: DELIVERY_ENV });
}
