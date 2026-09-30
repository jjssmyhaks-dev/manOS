import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WhatsApp Business Cloud API adapter (PRD §5). Verifies X-Hub-Signature-256,
 * parses inbound text/voice messages, and renders outbound payloads.
 * Actual send requires a token in connector config (not bundled).
 */

export interface WhatsAppInboundMessage {
  from: string;
  name?: string;
  text?: string;
  voiceMediaId?: string;
  voiceMimeType?: string;
  imageMediaId?: string;
  imageMimeType?: string;
  type: string;
  messageId: string;
  timestamp: string;
}

export function verifySignature(appSecret: string, rawBody: string, signature256: string | undefined): boolean {
  if (!signature256?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(signature256.slice(7), 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseWebhook(body: unknown): WhatsAppInboundMessage[] {
  const out: WhatsAppInboundMessage[] = [];
  const b = body as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
          messages?: Array<{
            from: string; id: string; timestamp: string; type: string;
            text?: { body?: string };
            audio?: { id?: string; mime_type?: string };
            image?: { id?: string; mime_type?: string };
          }>;
        };
      }>;
    }>;
  };
  for (const entry of b.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const name = value?.contacts?.[0]?.profile?.name;
      for (const msg of value?.messages ?? []) {
        out.push({
          from: msg.from,
          name,
          type: msg.type,
          text: msg.text?.body,
          voiceMediaId: msg.audio?.id,
          voiceMimeType: msg.audio?.mime_type,
          imageMediaId: msg.image?.id,
          imageMimeType: msg.image?.mime_type,
          messageId: msg.id,
          timestamp: msg.timestamp,
        });
      }
    }
  }
  return out;
}

export function buildOutboundText(to: string, body: string): Record<string, unknown> {
  return { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: body.slice(0, 4000) } };
}

// --- outbound delivery (WhatsApp Cloud API) ------------------------------------

/** Runtime WhatsApp Cloud API configuration from env. */
export function whatsappEnvConfig(): { token: string | null; phoneNumberId: string | null; echo: boolean; graphVersion: string } {
  const token = process.env.WHATSAPP_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN ?? null;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? null;
  // Echo mode: no credentials (or explicit WHATSAPP_ECHO=1) → sends are
  // recorded + audited but not delivered. Keeps dev/demo safe and free.
  const echo = process.env.WHATSAPP_ECHO === '1' || !token || !phoneNumberId;
  return { token, phoneNumberId, echo, graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? 'v21.0' };
}

/**
 * Download inbound media (voice note / ticket photo) from Meta's CDN:
 * GET /{media-id} returns a short-lived URL, then download the bytes.
 */
export async function fetchWhatsappMedia(mediaId: string, token: string, graphVersion = 'v21.0'): Promise<{ ok: boolean; base64?: string; mimeType?: string; error?: string }> {
  try {
    const meta = await fetch(`https://graph.facebook.com/${graphVersion}/${mediaId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const m = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; error?: { message?: string } };
    if (!meta.ok || !m.url) return { ok: false, error: m.error?.message ?? `media metadata HTTP ${meta.status}` };
    const bin = await fetch(m.url, { headers: { authorization: `Bearer ${token}` } });
    if (!bin.ok) return { ok: false, error: `media download HTTP ${bin.status}` };
    const buf = Buffer.from(await bin.arrayBuffer());
    return { ok: true, base64: buf.toString('base64'), mimeType: m.mime_type ?? 'application/octet-stream' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Send an audio voice note (Sarvam TTS output): upload the bytes to the
 * Cloud API media endpoint, then send an audio message referencing it.
 */
export async function sendWhatsAppAudio(
  cfg: { token: string; phoneNumberId: string; graphVersion?: string },
  to: string,
  audio: { base64: string; mimeType?: string }
): Promise<WhatsAppSendResult> {
  const version = cfg.graphVersion ?? 'v21.0';
  try {
    const form = new FormData();
    const bytes = Buffer.from(audio.base64, 'base64');
    form.append('file', new Blob([new Uint8Array(bytes)], { type: audio.mimeType ?? 'audio/mpeg' }), 'reply.mp3');
    form.append('type', audio.mimeType ?? 'audio/mpeg');
    form.append('messaging_product', 'whatsapp');
    const up = await fetch(`https://graph.facebook.com/${version}/${cfg.phoneNumberId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}` },
      body: form,
    });
    const upData = (await up.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!up.ok || !upData.id) return { ok: false, error: upData.error?.message ?? `media upload HTTP ${up.status}` };

    let res: Response;
    res = await fetch(`https://graph.facebook.com/${version}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'audio', audio: { id: upData.id } }),
    });
    const data = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string } };
    if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Live credential test: GET /{phoneNumberId} on the Graph API. A valid token
 * + phone number id returns the display name; anything else returns the
 * provider's error so setup problems surface at setup time.
 */
export async function whatsappTestConnection(cfg: { token: string; phoneNumberId: string; graphVersion?: string }): Promise<{ ok: boolean; displayName?: string; error?: string }> {
  const version = cfg.graphVersion ?? 'v21.0';
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${cfg.phoneNumberId}?access_token=${encodeURIComponent(cfg.token)}`);
    const data = (await res.json().catch(() => ({}))) as { name?: string; display_phone_number?: string; error?: { message?: string } };
    if (!res.ok || data.error) return { ok: false, error: data.error?.message ?? `Graph API HTTP ${res.status}` };
    return { ok: true, displayName: data.name ?? data.display_phone_number ?? 'WhatsApp number' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface WhatsAppSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** raw provider response on error (truncated) */
  detail?: string;
}

/**
 * Send a WhatsApp text message via the Meta Cloud API.
 * Throws only on unexpected failures; non-2xx responses are returned as
 * { ok:false, error, detail } so callers can retry with backoff.
 */
export async function sendWhatsAppText(cfg: { token: string; phoneNumberId: string; graphVersion?: string }, to: string, body: string): Promise<WhatsAppSendResult> {
  const version = cfg.graphVersion ?? 'v21.0';
  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${version}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildOutboundText(to, body)),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, error: `Cloud API ${res.status}`, detail: raw.slice(0, 300) };
  }
  try {
    const json = JSON.parse(raw) as { messages?: Array<{ id?: string }> };
    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch {
    return { ok: true };
  }
}
