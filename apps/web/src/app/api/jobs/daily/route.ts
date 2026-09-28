import { generateDigest } from '@factory/agents';
import { query, audit } from '@factory/db';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/jobs/daily — durable-workflow entry (Vercel Cron in prod).
 * Computes digests for all orgs and queues sends. In dev, call manually.
 */
export async function POST(req: Request) {
  // shared cron secret guard
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const orgs = await query<{ id: string; name: string }>('select id, name from organizations');
  const results: Array<{ org: string; overdue: number }> = [];
  for (const org of orgs) {
    const digest = await generateDigest(org.id);
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'daily_digest',$3,'queued')`,
      [org.id, org.name, digest.channelDrafts.whatsapp]
    );
    results.push({ org: org.name, overdue: digest.sections.find((x) => x.key === 'overdue')?.lines.length ?? 0 });
  }
  await audit(orgs[0]?.id ?? '00000000-0000-0000-0000-000000000000', 'system', 'jobs.daily_digest', { metadata: { orgs: results.length } });
  return Response.json({ ok: true, results });
}
