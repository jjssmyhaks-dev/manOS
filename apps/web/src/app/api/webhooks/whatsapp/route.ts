import { verifySignature, parseWebhook, whatsappEnvConfig, sendWhatsAppText } from '@factory/connectors';
import { query, audit } from '@factory/db';
import { extractDocument, runOrchestratorToText } from '@factory/agents';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * WhatsApp webhook (PRD §10) — verified + idempotent + conversational:
 * - hub verification (GET) and signature checks
 * - PO-like texts route to document intake (extraction → review queue)
 * - other texts are questions for the operations agent: the orchestrator
 *   answers from factory data and the reply is sent back on WhatsApp
 *   (echo mode in dev — recorded and audited, not delivered)
 * - voice notes queue for STT
 */

const INTAKE_ORG = '00000000-0000-0000-0000-000000000000';

/** Inbound number → owner org + role, with the seed org as dev fallback. */
async function resolveInboundOrg(from: string): Promise<{ orgId: string; role: string } | null> {
  const byOwner = await query<{ org_id: string }>(
    `select org_id from notify_settings where owner_phone = $1 limit 1`,
    [from]
  );
  if (byOwner[0]) return { orgId: byOwner[0].org_id, role: 'owner' };

  const byParty = await query<{ org_id: string }>(
    `select org_id from parties where phone = $1 limit 1`,
    [from]
  );
  if (byParty[0]) return { orgId: byParty[0].org_id, role: 'customer' };

  const fallback = await query<{ id: string }>(
    'select id from organizations order by created_at asc limit 1'
  );
  return fallback[0] ? { orgId: fallback[0].id, role: 'owner' } : null;
}

/** Does this inbound text look like a PO/invoice/challan to intake? */
function looksLikeDocument(text: string): boolean {
  return /\bpo\b|po number|purchase order|invoice|challan|quotation/i.test(text);
}

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

    await audit(INTAKE_ORG, 'system', 'whatsapp.message', {
      metadata: { messageId: msg.messageId, from: msg.from, type: msg.type },
    });

    if (msg.type === 'audio' && msg.voiceMediaId) {
      await query(
        `insert into notifications (org_id, channel, to_addr, template, body, status)
         values ($1,'webhook','stt-queue','voice_note',$2,'queued')`,
        [INTAKE_ORG, JSON.stringify({ messageId: msg.messageId, mediaId: msg.voiceMediaId, from: msg.from })]
      );
      handled.push(`voice:${msg.messageId}`);
      continue;
    }

    if (msg.text && looksLikeDocument(msg.text)) {
      const orgRows = await query<{ id: string }>('select id from organizations order by created_at asc limit 1');
      if (orgRows[0]) {
        await extractDocument(orgRows[0].id, { text: msg.text, source: 'whatsapp' });
        handled.push(`doc:${msg.messageId}`);
        continue;
      }
    }

    if (msg.text) {
      const target = await resolveInboundOrg(msg.from);
      if (!target) {
        handled.push(`text:${msg.messageId}`);
        continue;
      }
      try {
        const { conversationId, text: reply } = await runOrchestratorToText({
          orgId: target.orgId,
          role: target.role,
          message: msg.text,
          channel: 'whatsapp',
        });
        const envCfg = whatsappEnvConfig();
        await audit(target.orgId, 'agent', 'whatsapp.agent_reply', {
          entityType: 'conversation',
          entityId: conversationId,
          metadata: { to: msg.from, reply: reply.slice(0, 500), echo: envCfg.echo },
        });
        if (envCfg.echo) {
          // echo mode: reply audited above, not delivered (dev default)
          handled.push(`agent:${msg.messageId}:echo`);
        } else {
          const send = await sendWhatsAppText(
            { token: envCfg.token!, phoneNumberId: envCfg.phoneNumberId! },
            msg.from,
            reply
          );
          handled.push(`agent:${msg.messageId}:${send.ok ? 'sent' : `error:${(send.error ?? 'unknown').slice(0, 40)}`}`);
        }
      } catch (e) {
        console.error('whatsapp agent reply failed:', e);
        handled.push(`agent-error:${msg.messageId}`);
      }
      continue;
    }

    handled.push(`text:${msg.messageId}`);
  }

  return Response.json({ ok: true, handled });
}
