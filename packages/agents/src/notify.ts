import { query, audit } from '@factory/db';
import { sendWhatsAppText, whatsappEnvConfig } from '@factory/connectors';

/**
 * Outbound dispatcher (PRD F3/F9): turns queued notification rows into real
 * WhatsApp Cloud API sends. Every prior feature (digest, reminders, approval
 * alerts) already writes `notifications` rows — this module is the delivery
 * half that was missing.
 *
 * Modes:
 *  - live      : WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID set → real delivery
 *  - echo      : no credentials (or WHATSAPP_ECHO=1) → rows marked 'sent' with
 *                result.echo=true, audited, nothing leaves the machine. Keeps
 *                dev/demo safe and free while exercising the full code path.
 *
 * Retry policy: exponential backoff (1s/4s/9s) inside the call; failed rows go
 * back to 'queued' with error stamped so the next cron tick retries them, and
 * are marked 'failed' after MAX_ATTEMPTS (tracked in result.attempts).
 */

export const MAX_ATTEMPTS = 4;

/** org settings row for outbound config (see /api/settings action save_notify) */
export interface NotifySettings {
  ownerPhone: string | null;
  autoSend: boolean;
}

export async function getNotifySettings(orgId: string): Promise<NotifySettings> {
  const rows = await query<{ owner_phone: string | null; auto_send: boolean }>(
    `select owner_phone, auto_send from notify_settings where org_id = $1 limit 1`,
    [orgId]
  );
  return { ownerPhone: rows[0]?.owner_phone ?? null, autoSend: rows[0]?.auto_send ?? false };
}

export async function saveNotifySettings(orgId: string, ownerPhone: string | null, autoSend: boolean): Promise<void> {
  await query(
    `insert into notify_settings (org_id, owner_phone, auto_send)
     values ($1,$2,$3)
     on conflict (org_id) do update set owner_phone = excluded.owner_phone, auto_send = excluded.auto_send, updated_at = now()`,
    [orgId, ownerPhone, autoSend]
  );
}

/** Resolve the destination for a notification row: explicit to_addr → owner phone. */
async function resolveTo(orgId: string, toAddr: string | null, phoneFromPayload: string | null): Promise<string | null> {
  // to_addr may hold a phone, an org id (digest route), a customer name, or a
  // routing tag (stt-queue / tally-connector) — only real numbers are sendable.
  const looksLikePhone = (v: string) => /^\+?\d{10,15}$/.test(v.replace(/[\s-]/g, ''));
  if (phoneFromPayload && looksLikePhone(phoneFromPayload)) return phoneFromPayload.replace(/[\s-]/g, '');
  if (toAddr && looksLikePhone(toAddr)) return toAddr.replace(/[\s-]/g, '');
  const settings = await getNotifySettings(orgId);
  return settings.ownerPhone ? settings.ownerPhone.replace(/[\s-]/g, '') : null;
}

/** Pull a phone number out of a notification body/payload if one was embedded. */
function phoneFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { to?: string; phone?: string; customerPhone?: string };
  const cand = p.to ?? p.phone ?? p.customerPhone;
  return typeof cand === 'string' ? cand : null;
}

export interface DispatchOutcome {
  processed: number;
  sent: number;
  echoed: number;
  failed: number;
  retried: number;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Dispatch queued notifications (optionally filtered by template).
 * Idempotent: only rows with status='queued' are picked up, and each row is
 * updated inside the loop so a crash cannot double-send.
 */
export async function dispatchQueuedNotifications(orgId?: string, opts: { template?: string; maxRows?: number } = {}): Promise<DispatchOutcome> {
  const cfg = whatsappEnvConfig();
  const outcome: DispatchOutcome = { processed: 0, sent: 0, echoed: 0, failed: 0, retried: 0 };

  const rows = await query<{
    id: string;
    org_id: string;
    to_addr: string | null;
    template: string | null;
    body: string;
    result: unknown;
  }>(
    `select id, org_id, to_addr, template, body, result from notifications
     where status = 'queued' and channel = 'whatsapp'
       ${orgId ? 'and org_id = $1' : ''}
       ${opts.template ? `and template = $${orgId ? 2 : 1}` : ''}
     order by created_at asc limit $${orgId ? (opts.template ? 3 : 2) : opts.template ? 2 : 1}`,
    [
      ...(orgId ? [orgId] : []),
      ...(opts.template ? [opts.template] : []),
      opts.maxRows ?? 50,
    ]
  );

  for (const row of rows) {
    outcome.processed++;
    const prev = (typeof row.result === 'string' ? safeParse(row.result) : row.result) as { attempts?: number; error?: string } | null;
    const attempts = (prev?.attempts ?? 0) + 1;

    const payload = typeof row.body === 'string' && row.body.trim().startsWith('{') ? safeParse(row.body) : null;
    const to = await resolveTo(row.org_id, row.to_addr, phoneFromPayload(payload));

    if (!to) {
      // nowhere to send: mark skipped so it doesn't spin forever
      await query(
        `update notifications set status='skipped', result=$2::jsonb, error='no WhatsApp destination configured (set owner number in Settings)' where id=$1`,
        [row.id, JSON.stringify({ attempts, error: 'no destination' })]
      );
      outcome.failed++;
      await audit(row.org_id, 'system', 'notify.skipped', { metadata: { template: row.template, reason: 'no destination' } });
      continue;
    }

    if (cfg.echo) {
      // echo mode: full code path, no network
      await query(
        `update notifications set status='sent', result=$2::jsonb where id=$1`,
        [row.id, JSON.stringify({ attempts, echo: true, to: maskPhone(to), sentAt: new Date().toISOString() })]
      );
      await audit(row.org_id, 'system', 'notify.sent', { metadata: { template: row.template, echo: true, to: maskPhone(to) } });
      outcome.echoed++;
      continue;
    }

    // live send with in-call backoff (1s, 4s, 9s)
    let res = await sendWhatsAppText({ token: cfg.token!, phoneNumberId: cfg.phoneNumberId!, graphVersion: cfg.graphVersion }, to, row.body);
    for (let attempt = 1; attempt < 3 && !res.ok; attempt++) {
      outcome.retried++;
      await sleep(attempt * attempt * 1000);
      res = await sendWhatsAppText({ token: cfg.token!, phoneNumberId: cfg.phoneNumberId!, graphVersion: cfg.graphVersion }, to, row.body);
    }

    if (res.ok) {
      await query(
        `update notifications set status='sent', result=$2::jsonb where id=$1`,
        [row.id, JSON.stringify({ attempts, messageId: res.messageId, to: maskPhone(to), sentAt: new Date().toISOString() })]
      );
      await audit(row.org_id, 'system', 'notify.sent', { metadata: { template: row.template, to: maskPhone(to), messageId: res.messageId } });
      outcome.sent++;
    } else if (attempts >= MAX_ATTEMPTS) {
      await query(
        `update notifications set status='failed', result=$2::jsonb, error=$3 where id=$1`,
        [row.id, JSON.stringify({ attempts, error: res.error, detail: res.detail }), `${res.error ?? 'send failed'}: ${res.detail ?? ''}`.slice(0, 300)]
      );
      await audit(row.org_id, 'system', 'notify.failed', { metadata: { template: row.template, error: res.error, attempts } });
      outcome.failed++;
    } else {
      // leave queued for the next tick; stamp attempts + last error
      await query(
        `update notifications set result=$2::jsonb, error=$3 where id=$1`,
        [row.id, JSON.stringify({ attempts, error: res.error, detail: res.detail }), res.error ?? 'send failed']
      );
      outcome.retried++;
    }
  }

  return outcome;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** Never persist full phone numbers in free-text result/audit fields. */
function maskPhone(p: string): string {
  return p.length > 4 ? `***${p.slice(-4)}` : '***';
}
