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
            audio?: { id?: string };
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
