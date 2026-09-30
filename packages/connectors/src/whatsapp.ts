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
