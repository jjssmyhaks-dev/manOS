import { query, audit } from '@factory/db';

/**
 * WhatsApp self-registration for customers (A12 extension): a number the
 * workspace doesn't know gets a CONVERSATIONAL code-collection flow — the
 * same phone IS the product principle. Two entry paths:
 *   1. proactive: the webhook answers an unknown number once with the ask
 *      (identifyOrderReply), then this module tracks the pending state;
 *   2. passive: any inbound text containing order/invoice-number-looking
 *      tokens triggers a match attempt regardless of pending state.
 * A confirmed match ATTACHES the number to the party record (so webhook
 * routing resolves next time) and tells the owner a new customer connected.
 * No message ever sends to a number that never identified itself.
 */

export interface RegistrationState {
  pending: boolean;
  attempts: number;
  askedAt: string | null;
  expiresAt: string | null;
}

export async function getRegistrationState(from: string): Promise<RegistrationState> {
  const rows = await query<{ settings: unknown }>(`select settings from wa_registrations where phone = $1`, [from]);
  const s = (rows[0]?.settings ?? {}) as { pending?: boolean; attempts?: number; askedAt?: string; expiresAt?: string };
  return {
    pending: Boolean(s.pending),
    attempts: s.attempts ?? 0,
    askedAt: s.askedAt ?? null,
    expiresAt: s.expiresAt ?? null,
  };
}

/** Remember that we asked this number to identify itself. */
export async function markAsked(orgId: string | null, from: string): Promise<void> {
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  await query(
    `insert into wa_registrations (org_id, phone, settings) values ($1,$2,$3::jsonb)
     on conflict (phone) do update set
       org_id = excluded.org_id,
       settings = wa_registrations.settings || excluded.settings`,
    [orgId, from, JSON.stringify({ pending: true, askedAt: new Date().toISOString(), expiresAt: expires })]
  );
}

export async function clearPending(from: string): Promise<void> {
  await query(`update wa_registrations set settings = settings || '{"pending": false}'::jsonb where phone = $1`, [from]);
}

export function isExpired(state: RegistrationState): boolean {
  return Boolean(state.expiresAt && new Date(state.expiresAt).getTime() < Date.now());
}

export function identifyOrderReply(): string {
  return [
    'Hello! 👋 This number isn’t linked to an order yet.',
    'Reply with your *order number* (e.g. SO-1023) or *invoice number* (e.g. INV-2044) and I’ll pull up your status.',
  ].join('\n');
}

/** Order/invoice-number-looking tokens ("SO-1023", "INV2044", "INV 2044"). */
export function extractOrderCodes(text: string): string[] {
  const raw = text.toUpperCase().match(/\b(?:SO|INV|PO)[- ]?(\d{2,6})\b/g) ?? [];
  return raw.map((c) => c.replace(/[\s-]/g, '').replace(/^(SO|INV|PO)/, '$1-'));
}

export interface MatchResult {
  matched: boolean;
  alreadyLinked?: boolean;
  orgId?: string;
  partyId?: string;
  partyName?: string;
  orderCode?: string;
  orderStatus?: string;
  reply?: string;
}

/**
 * Try to match the code (any org — the number finds its own workspace),
 * attach the phone to that party, notify the owner, and stamp the
 * registration resolved.
 */
export async function matchAndAttach(from: string, code: string): Promise<MatchResult> {
  const norm = code.replace(/[\s-]/g, '').toUpperCase();
  const rows = await query<{ org_id: string; party_id: string | null; status: string | null; customer: string | null }>(
    `select e.org_id, e.party_id, e.status,
            coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), '(unknown)') as customer
     from entities e
     where e.type in ('sales_order','invoice') and replace(upper(e.code), '-', '') = $1
     order by e.created_at desc limit 1`,
    [norm]
  );
  const hit = rows[0];
  if (!hit) {
    return { matched: false, reply: `I couldn’t find an order or invoice numbered ${code} — double-check it? You can also reply with the other number if you have both.` };
  }
  if (!hit.party_id) {
    return { matched: false, reply: `I found ${code} but it has no customer linked on file — please share your registered phone number or contact the factory directly.` };
  }

  const party = (
    await query<{ phone: string | null; name: string | null }>(
      `select coalesce(data->>'phone','') as phone, coalesce(name, data->>'name') as name from entities where id = $1`,
      [hit.party_id]
    )
  )[0];
  const phones = (party?.phone ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const alreadyLinked = phones.includes(from);

  if (!alreadyLinked) {
    // append the number to the party's phone list (never overwrite an existing contact)
    const merged = [...phones, from].join(',');
    await query(`update entities set data = jsonb_set(data, '{phone}', to_jsonb($3::text)) where id = $2 and org_id = $1`, [hit.org_id, hit.party_id, merged]);
  }
  await clearPending(from);
  await audit(hit.org_id, 'system', 'customer.self_registered', {
    entityId: hit.party_id ?? undefined,
    metadata: { phone: `***${from.slice(-4)}`, order: norm, alreadyLinked },
  });

  const reply = alreadyLinked
    ? `Welcome back! ${hit.customer} — order ${code} is *${hit.status ?? 'in process'}*. What would you like to know?`
    : `Thanks ${hit.customer}! 🎉 Your number is now linked to ${code} (${hit.status ?? 'in process'}). Ask me anything about it — status, delivery, documents.`;

  if (!alreadyLinked) {
    // the owner learns a new customer connected (queued; policy-governed channel)
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp','owner','customer_self_registered',$2,'queued')`,
      [hit.org_id, `📱 New customer connected: ${hit.customer} (***${from.slice(-4)}) linked themselves to ${norm}. Their WhatsApp is now a service channel.`]
    );
  }

  return { matched: true, alreadyLinked, orgId: hit.org_id, partyId: hit.party_id ?? undefined, partyName: hit.customer ?? undefined, orderCode: code, orderStatus: hit.status ?? undefined, reply };
}
