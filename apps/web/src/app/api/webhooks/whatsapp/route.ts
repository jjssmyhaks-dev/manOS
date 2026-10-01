import {
  verifySignature,
  parseWebhook,
  whatsappEnvConfig,
  sendWhatsAppText,
  sendWhatsAppAudio,
  transcribeVoiceNote,
  fetchWhatsappMedia,
  synthesizeSpeech,
} from '@factory/connectors';
import { query, audit } from '@factory/db';
import {
  extractDocument,
  runOrchestratorToText,
  parseApprovalCommand,
  decideApprovalFromWhatsApp,
  pendingListMessage,
  extractWeighbridgeFromText,
  extractWeighbridgeFromImage,
  processWeighbridgeTicket,
  looksLikeWeighbridgeText,
  processShiftNote,
  detectPromiseToPay,
  handleCustomerMessage,
  executeAction,
} from '@factory/agents';
import { query as dbQuery } from '@factory/db';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * WhatsApp webhook (PRD §10) — the phone IS the product:
 * - hub verification (GET) + signature checks
 * - text questions → the operations agent answers from factory data
 * - approval commands → approve APPR-xxxxxxxx / reject … / pending — decided
 *   on the spot, executed once, outcome reported back to the phone
 * - PO-like texts → document intake (extraction → review queue)
 * - voice notes → Sarvam STT → the same agent loop (Hinglish in, answer out)
 * Replies go out via the Cloud API (echo mode in dev: audited, not delivered).
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

/** Send a reply in live mode; in echo mode the caller records it instead. */
async function replyTo(to: string, body: string): Promise<'sent' | 'echo' | 'error'> {
  const envCfg = whatsappEnvConfig();
  if (envCfg.echo) return 'echo';
  const send = await sendWhatsAppText({ token: envCfg.token!, phoneNumberId: envCfg.phoneNumberId! }, to, body);
  return send.ok ? 'sent' : 'error';
}

/** Fetch a pending list and format it for the phone. */
async function pendingFor(orgId: string): Promise<string> {
  const rows = await query<{ id: string; action_type: string; preview: string | null; created_at: string }>(
    "select id, action_type, preview, created_at from approvals where org_id = $1 and status = 'pending' order by created_at desc limit 11",
    [orgId]
  );
  return pendingListMessage(rows);
}

const HELP_TEXT = [
  'You can ask me anything about your factory — "kitna overdue hai?", "stock of MS bracket", "sales is week".',
  '',
  'I can also act for you:',
  '• *pending* — see what is waiting for your approval',
  '• *approve APPR-xxxxxxxx* — do it',
  '• *reject APPR-xxxxxxxx* — don\u2019t',
  '• *activity* — the last few things I did',
  '',
  'Send weighbridge tickets as a photo or just type: *gross 5420 tare 1220 grade MS solid from Ramesh*',
  'Voice notes work too — bas bol do 🎙️',
].join('\n');

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

    // --- voice notes: transcribe with Sarvam, then treat as text -------------
    if (msg.type === 'audio' && msg.voiceMediaId) {
      const target = await resolveInboundOrg(msg.from);
      if (!target) {
        handled.push(`voice:${msg.messageId}:no-org`);
        continue;
      }
      const mediaRows = await query<{ id: string; mime_type: string | null; url: string }>(
        'select id, mime_type, url from wa_media where media_id = $1 order by created_at desc limit 1',
        [msg.voiceMediaId]
      );
      let transcript: string | null = null;
      if (mediaRows[0]) {
        const stt = await transcribeVoiceNote(mediaRows[0].url, process.env.WHATSAPP_TOKEN ?? '', {
          mimeType: mediaRows[0].mime_type ?? msg.voiceMimeType,
        });
        if (stt.ok && stt.text) {
          transcript = stt.text;
        } else {
          const mode0 = await replyTo(msg.from, stt.error?.includes('SARVAM_API_KEY')
            ? 'Voice notes are not enabled on this deployment yet — type your question and I\u2019ll answer right away.'
            : 'Sorry, I couldn\u2019t hear that properly. Type it as a message and I\u2019ll answer right away.');
          await audit(target.orgId, 'agent', 'whatsapp.voice_note', {
            metadata: { messageId: msg.messageId, ok: false, error: stt.error?.slice(0, 200), replied: mode0 },
          });
          handled.push(`voice:${msg.messageId}:stt-error`);
          continue;
        }
      } else {
        // remember the media id so an operator-side fetch can fill url later;
        // without a stored URL we cannot transcribe in-process
        await query(
          `insert into wa_media (org_id, media_id, mime_type, status) values ($1,$2,$3,'pending')`,
          [target.orgId, msg.voiceMediaId, msg.voiceMimeType ?? null]
        );
        const mode0 = await replyTo(msg.from, 'Got your voice note — processing it now. If I stay quiet, type it as a message and I\u2019ll answer right away.');
        await audit(target.orgId, 'agent', 'whatsapp.voice_note', {
          metadata: { messageId: msg.messageId, ok: false, error: 'media metadata not fetched (webhook lag)', replied: mode0 },
        });
        handled.push(`voice:${msg.messageId}:deferred`);
        continue;
      }

      // A8 shift-report fast path: a voice note that reads like a shift log
      // (output/rejects/downtime + optional job card) becomes a structured
      // report instead of a general chat answer. Anything else falls through
      // to the orchestrator as before.
      const shiftish = /\b(output|produc|reject|kharab|downtime|job\s*card|jc[-\s]?\d)\b/i.test(transcript);
      if (shiftish) {
        const shift = await processShiftNote(target.orgId, transcript, { role: target.role, via: 'whatsapp-voice' });
        const mode1 = await replyTo(msg.from, shift.reply);
        await audit(target.orgId, 'agent', 'whatsapp.shift_note', {
          metadata: { messageId: msg.messageId, transcript: transcript.slice(0, 300), decision: shift.decision ?? (shift.needsClarification ? 'clarify' : 'none'), replied: mode1, flags: shift.flags },
        });
        handled.push(`shift:${msg.messageId}:${shift.needsClarification ? 'clarify' : (shift.decision ?? 'done')}`);
        continue;
      }

      const { conversationId, text: reply } = await runOrchestratorToText({
        orgId: target.orgId,
        role: target.role,
        message: `(voice note) ${transcript}`,
        channel: 'whatsapp',
      });
      const mode1 = await replyTo(msg.from, reply);
      // they spoke, so speak back: Sarvam Bulbul TTS as a voice note
      let ttsMode: string = 'disabled';
      const speech = await synthesizeSpeech(reply);
      if (speech.ok && speech.audioBase64) {
        const envCfg2 = whatsappEnvConfig();
        if (envCfg2.echo) {
          ttsMode = 'echo';
        } else {
          const audioSend = await sendWhatsAppAudio(
            { token: envCfg2.token!, phoneNumberId: envCfg2.phoneNumberId!, graphVersion: envCfg2.graphVersion },
            msg.from,
            { base64: speech.audioBase64, mimeType: speech.mimeType }
          );
          ttsMode = audioSend.ok ? 'sent' : `error:${(audioSend.error ?? '').slice(0, 40)}`;
        }
      } else {
        ttsMode = `skip:${(speech.error ?? '').slice(0, 30)}`;
      }
      await audit(target.orgId, 'agent', 'whatsapp.voice_note', {
        entityType: 'conversation',
        entityId: conversationId,
        metadata: { messageId: msg.messageId, transcript: transcript.slice(0, 300), replied: mode1, tts: ttsMode },
      });
      handled.push(`voice:${msg.messageId}:agent:${ttsMode.split(':')[0]}`);
      continue;
    }

    // --- photos: weighbridge ticket intake (F8 scrap pack) -------------------
    if (msg.type === 'image' && msg.imageMediaId) {
      const target = await resolveInboundOrg(msg.from);
      if (!target) {
        handled.push(`image:${msg.messageId}:no-org`);
        continue;
      }
      const media = await fetchWhatsappMedia(msg.imageMediaId, process.env.WHATSAPP_TOKEN ?? '');
      if (!media.ok || !media.base64) {
        await replyTo(msg.from, 'I could not download that photo — please try sending it again.');
        handled.push(`image:${msg.messageId}:media-error`);
        continue;
      }
      try {
        const ticket = await extractWeighbridgeFromImage(media.base64, media.mimeType);
        const result = await processWeighbridgeTicket(target.orgId, ticket, { from: msg.from, via: 'whatsapp-photo' });
        await replyTo(msg.from, result.reply);
        handled.push(`weighbridge:${msg.messageId}:${result.ok ? 'ok' : 'parse-error'}`);
      } catch (e) {
        const msg2 = e instanceof Error ? e.message : 'Could not read the ticket';
        await replyTo(msg.from, /live AI key/i.test(msg2)
          ? 'Reading ticket photos needs the live AI key (operator setting). For now, type it: *gross 5420 tare 1220 grade MS solid from Ramesh*'
          : `I could not read the ticket clearly (${msg2.slice(0, 80)}). Type the weights instead: *gross 5420 tare 1220 grade MS solid from Ramesh*`);
        handled.push(`weighbridge:${msg.messageId}:error`);
      }
      continue;
    }

    // --- text messages --------------------------------------------------------
    if (msg.text) {
      const cmd = parseApprovalCommand(msg.text);

      if (cmd.cmd === 'help') {
        await replyTo(msg.from, HELP_TEXT);
        handled.push(`help:${msg.messageId}`);
        continue;
      }

      if (cmd.cmd === 'other' && /^activity$/i.test(msg.text.trim())) {
        const target = await resolveInboundOrg(msg.from);
        if (target) {
          const { listActivity } = await import('@factory/agents');
          const recent = await listActivity(target.orgId, { limit: 5 });
          const body = recent.length
            ? ['🧾 *Last things I did*', '', ...recent.map((a) => `• ${a.summary}`)].join('\n')
            : 'Nothing on the activity log yet.';
          await replyTo(msg.from, body);
        }
        handled.push(`activity:${msg.messageId}`);
        continue;
      }

      if (cmd.cmd === 'other' && looksLikeWeighbridgeText(msg.text)) {
        const target = await resolveInboundOrg(msg.from);
        if (target) {
          const ticket = extractWeighbridgeFromText(msg.text);
          const result = await processWeighbridgeTicket(target.orgId, ticket, { from: msg.from, via: 'whatsapp-text' });
          await replyTo(msg.from, result.reply);
          handled.push(`weighbridge:${msg.messageId}:${result.ok ? 'ok' : 'parse-error'}`);
          continue;
        }
      }

      // A12: inbound from a known CUSTOMER number (not the owner) — order
      // status / complaint intake with human-handoff on escalation
      {
        const partyRow = (
          await dbQuery<{ org_id: string; id: string; name: string | null }>(
            `select org_id, id, coalesce(name, data->>'name') as name from parties where phone = $1 limit 1`,
            [msg.from]
          )
        )[0];
        const ownerHere = await dbQuery<{ org_id: string }>(`select org_id from notify_settings where owner_phone = $1 limit 1`, [msg.from]);
        if (partyRow && !ownerHere[0]) {
          const cs = await handleCustomerMessage(partyRow.org_id, {
            customerId: partyRow.id,
            customerName: partyRow.name ?? 'Customer',
            text: msg.text,
          });
          await replyTo(msg.from, cs.reply);
          handled.push(`customer:${msg.messageId}:${cs.intent}${cs.escalated ? ':escalated' : ''}`);
          continue;
        }
      }

      // A4: a customer reply mentioning a payment date becomes a SUGGESTED
      // promise-to-pay for the owner to confirm (never auto-applied)
      if (cmd.cmd === 'other' && detectPromiseToPay(msg.text)) {
        const ptp = detectPromiseToPay(msg.text)!;
        const target = await resolveInboundOrg(msg.from);
        if (target) {
          const latest = (
            await dbQuery<{ id: string; code: string | null }>(
              `select e.id, e.code from entities e join entities p on p.id = e.party_id
               where e.org_id = $1 and e.type = 'invoice' and p.data->>'phone' = $2
                 and e.status in ('sent','overdue','partial') order by e.date desc limit 1`,
              [target.orgId, msg.from]
            )
          )[0];
          if (latest) {
            await dbQuery(
              `insert into entities (id, org_id, type, status, party_id, source, data)
               values (gen_random_uuid()::text, $1, 'promise_to_pay', 'suggested', (select party_id from entities where id = $2), 'agent', $3::jsonb)`,
              [target.orgId, latest.id, JSON.stringify({ invoiceId: latest.id, invoice: latest.code, promiseDate: ptp.date, via: 'whatsapp-reply', confidence: ptp.confidence, text: msg.text.slice(0, 200) })]
            );
            await replyTo(msg.from, `Noted — I've queued "payment by ${ptp.date}" for confirmation. Thank you!`);
            handled.push(`promise:${msg.messageId}:${ptp.confidence}`);
            continue;
          }
        }
      }

      if (cmd.cmd === 'pending') {
        const target = await resolveInboundOrg(msg.from);
        const listText = target ? await pendingFor(target.orgId) : 'No workspace found for this number.';
        await replyTo(msg.from, listText);
        handled.push(`pending:${msg.messageId}`);
        continue;
      }

      if (cmd.cmd === 'approve' || cmd.cmd === 'reject') {
        const target = await resolveInboundOrg(msg.from);
        if (!target || target.role !== 'owner') {
          await replyTo(msg.from, 'Only the workspace owner can decide approvals from WhatsApp.');
          handled.push(`approve:${msg.messageId}:not-owner`);
          continue;
        }
        const res = await decideApprovalFromWhatsApp(
          target.orgId,
          cmd.approvalId,
          cmd.cmd,
          `whatsapp:${msg.from}`,
          (actionType, payload) => executeAction(target.orgId, actionType, payload as Record<string, unknown>)
        );
        await replyTo(msg.from, res.reply);
        handled.push(`approve:${msg.messageId}:${res.ok ? 'ok' : 'not-found'}`);
        continue;
      }

      if (looksLikeDocument(msg.text)) {
        const orgRows = await query<{ id: string }>('select id from organizations order by created_at asc limit 1');
        if (orgRows[0]) {
          await extractDocument(orgRows[0].id, { text: msg.text, source: 'whatsapp' });
          handled.push(`doc:${msg.messageId}`);
          continue;
        }
      }

      // plain question → the agent answers
      const target = await resolveInboundOrg(msg.from);
      if (!target) {
        handled.push(`text:${msg.messageId}:no-org`);
        continue;
      }
      try {
        const { conversationId, text: reply } = await runOrchestratorToText({
          orgId: target.orgId,
          role: target.role,
          message: msg.text,
          channel: 'whatsapp',
        });
        await audit(target.orgId, 'agent', 'whatsapp.agent_reply', {
          entityType: 'conversation',
          entityId: conversationId,
          metadata: { to: msg.from, reply: reply.slice(0, 500), echo: whatsappEnvConfig().echo },
        });
        const mode = await replyTo(msg.from, reply);
        handled.push(`agent:${msg.messageId}:${mode}`);
      } catch (e) {
        console.error('whatsapp agent reply failed:', e);
        await replyTo(msg.from, 'Sorry — something went wrong on my side. Please try again in a minute.');
        handled.push(`agent-error:${msg.messageId}`);
      }
      continue;
    }

    handled.push(`skip:${msg.messageId}`);
  }

  return Response.json({ ok: true, handled });
}
