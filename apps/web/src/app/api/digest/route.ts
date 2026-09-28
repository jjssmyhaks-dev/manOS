import { generateDigest } from '@factory/agents';
import { query, audit } from '@factory/db';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** GET /api/digest/preview — build today's digest without sending (PRD F3). */
export async function GET() {
  const s = await getSession();
  const digest = await generateDigest(s.orgId);
  return Response.json({ digest });
}

/** POST /api/digest — queue digest send (email/WhatsApp) via policy. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as { channels?: string[] };
  const digest = await generateDigest(s.orgId);

  for (const channel of body.channels ?? ['web']) {
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,$2,$3,$4,$5,'queued')`,
      [s.orgId, channel, s.orgId, 'daily_digest', channel === 'whatsapp' ? digest.channelDrafts.whatsapp : digest.channelDrafts.email]
    );
  }
  await audit(s.orgId, 'system', 'digest.queued', { metadata: { channels: body.channels ?? ['web'] } });
  return Response.json({ ok: true, queued: body.channels ?? ['web'], digest });
}
