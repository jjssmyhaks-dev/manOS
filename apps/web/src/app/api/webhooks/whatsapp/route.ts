import { verifySignature, parseWebhook } from '@factory/connectors';
import { query, audit } from '@factory/db';
import { extractDocument } from '@factory/agents';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/webhooks/whatsapp — verified + idempotent (PRD §10).
 * Text messages with PO-like content are routed to the document intake
 * pipeline; voice notes are queued for STT (Sarvam, P1). GET handles
 * Meta's hub verification challenge.
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token && token === (process.env.WHATSAPP_VERIFY_TOKEN ?? 'factory-demo')) {
    return new Response(challenge ?? '', { status: 200 });
  }
  return new Response('forbidden', { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret && !verifySignature(appSecret, raw, req.headers.get('x-hub-signature-256') ?? undefined)) {
    return Response.json({ error: 'invalid signature' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'bad json' }, { status: 400 });
  }

  const messages = parseWebhook(body);
  const handled: string[] = [];

  for (const msg of messages) {
    // idempotency: skip if messageId already processed
    const seen = await query<{ id: string }>(
      `select id from audit_log where action='whatsapp.message' and metadata->>'messageId'=$1 limit 1`,
      [msg.messageId]
    );
    if (seen[0]) continue;

    await audit('00000000-0000-0000-0000-000000000000', 'system', 'whatsapp.message', {
      metadata: { messageId: msg.messageId, from: msg.from, type: msg.type },
    });

    if (msg.type === 'audio' && msg.voiceMediaId) {
      await query(
        `insert into notifications (org_id, channel, to_addr, template, body, status)
         values ('00000000-0000-0000-0000-000000000000','webhook','stt-queue','voice_note',$1,'queued')`,
        [JSON.stringify({ messageId: msg.messageId, mediaId: msg.voiceMediaId, from: msg.from })]
      );
      handled.push(`voice:${msg.messageId}`);
      continue;
    }

    if (msg.text && /po|order|invoice| Challan|quotation/i.test(msg.text)) {
      const orgRows = await query<{ id: string }>('select id from organizations order by created_at asc limit 1');
      if (orgRows[0]) {
        await extractDocument(orgRows[0].id, { text: msg.text, source: 'whatsapp' });
        handled.push(`doc:${msg.messageId}`);
        continue;
      }
    }
    handled.push(`text:${msg.messageId}`);
  }

  return Response.json({ ok: true, handled });
}
