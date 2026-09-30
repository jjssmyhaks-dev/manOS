import { generateAllPilotDigests, pilotDigestText } from '@factory/agents';
import { audit, query } from '@factory/db';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/jobs/pilot-digest — weekly pilot feedback digest (operator-facing;
 * sent to US, never the owner): usage stats, override-rate trend and top
 * correction themes per org — the case-study raw material. Queues one
 * notification per org under template 'pilot_digest' and audits the run.
 * Also registered in vercel.json as a Monday cron.
 * Guarded by CRON_SECRET when set (Authorization: Bearer <secret>).
 */
async function guard(req: Request): Promise<Response | null> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return null;
}

export async function POST(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;

  const digests = await generateAllPilotDigests();
  for (const r of digests) {
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'email',$2,'pilot_digest',$3,'queued')`,
      [r.orgId, 'operator@factoryaios.in', pilotDigestText(r)]
    );
  }
  await audit(digests[0]?.orgId ?? '00000000-0000-0000-0000-000000000000', 'system', 'jobs.pilot_digest', {
    metadata: { orgs: digests.length },
  });

  return Response.json({ ok: true, orgs: digests.length, digests });
}

/** GET — a dry-run preview of the current report without queuing notifications. */
export async function GET(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;
  const digests = await generateAllPilotDigests();
  return Response.json({ ok: true, orgs: digests.length, preview: digests.map(pilotDigestText) });
}
