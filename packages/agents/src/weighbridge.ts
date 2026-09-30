import { generateObject } from 'ai';
import { z } from 'zod';
import { query, insertEntity, audit } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { getModel, getModelConfig } from './models.js';
import { executeAction } from './tools/write.js';
import type { ActionSource } from './activity.js';

/**
 * F8 scrap/waste pack — weighbridge intake (PRD v2 §7):
 * the operator sends a ticket photo (or just types the weights) on WhatsApp
 * → gross/tare/net + material grade are read → matched to the seller and the
 * day's grade rate → a purchase entry is DRAFTED through the policy engine
 * → the owner approves (web or WhatsApp) → it syncs to Tally.
 * Every step lands on the AI Activity timeline with the ticket as its source.
 */

export const WeighbridgeTicketSchema = z.object({
  ticketNo: z.string().nullable().describe('Weighbridge ticket/slip number'),
  vehicleNo: z.string().nullable(),
  sellerName: z.string().nullable().describe('Supplier / small-seller name on the ticket'),
  material: z.string().nullable().describe('Material, e.g. MS scrap, paper, plastic'),
  grade: z.string().nullable().describe('Grade code, e.g. MS-solid, HR-bundles, OCC'),
  grossKg: z.number().positive().nullable(),
  tareKg: z.number().nonnegative().nullable(),
  netKg: z.number().positive().nullable(),
  date: z.string().nullable().describe('YYYY-MM-DD'),
});

export type WeighbridgeTicket = z.infer<typeof WeighbridgeTicketSchema>;

/** Deterministic text parse (works in dev/mock without any API key). */
export function extractWeighbridgeFromText(text: string): WeighbridgeTicket {
  const num = (label: string): number | null => {
    const m = text.match(new RegExp(`${label}\\s*[:\\-]?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(kg|kgs)?`, 'i'));
    return m ? Number(m[1]!.replace(/,/g, '')) : null;
  };
  const gross = num('gross');
  const tare = num('tare');
  const netExplicit = num('net');
  const net = netExplicit ?? (gross != null && tare != null ? gross - tare : null);
  // labelled fields end at the next keyword — sellers are named people, not sentences
  const until = '(?=(?:\\bfrom\\b|\\bticket\\b|\\bvehicle\\b|\\bgrade\\b|\\bgross\\b|\\btare\\b|\\bnet\\b|,|$))';
  const grade = text.match(new RegExp(`grade\\s*[:\\-]?\\s*([A-Za-z0-9][A-Za-z0-9 \\-]{0,20}?)${until}`, 'i'))?.[1]?.trim() ?? null;
  const material = text.match(/(ms scrap|ss scrap|paper|plastic|occ|iron|steel|aluminium|aluminum|copper|brass|cardboard|glass)/i)?.[1] ?? null;
  const seller = text.match(new RegExp(`(?:from|seller|supplier|party)\\s*[:\\-]?\\s*([A-Za-z][A-Za-z0-9 &.\\-]{1,40}?)${until}`, 'i'))?.[1]?.trim().replace(/\s+/g, ' ') ?? null;
  const vehicle = text.match(/(?:vehicle|truck|tempo)\s*(?:no|number)?\s*[:\-]?\s*([A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{3,4})/i)?.[1] ?? null;
  const ticketNo = text.match(/(?:ticket|slip)\s*(?:no|number)?\s*[:\-]?\s*([A-Z0-9\-\/]{3,})/i)?.[1] ?? null;
  const date = text.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);
  return {
    ticketNo, vehicleNo: vehicle, sellerName: seller, material, grade,
    grossKg: gross, tareKg: tare, netKg: net, date,
  };
}

/** Vision path for ticket photos (needs a live model key; explicit error otherwise). */
export async function extractWeighbridgeFromImage(
  imageBase64: string,
  mimeType = 'image/jpeg'
): Promise<WeighbridgeTicket> {
  const cfg = getModelConfig();
  if (!(cfg.profile === 'prod' && cfg.openRouterApiKey)) {
    throw new Error('Ticket photos need a live AI key — ask the operator to enable it, or type the weights as a message (e.g. "gross 5420 tare 1220 grade MS solid from Ramesh").');
  }
  const { object } = await generateObject({
    model: getModel('fast'),
    schema: WeighbridgeTicketSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'This is a photo of an Indian weighbridge ticket for scrap/waste purchase. Read gross weight, tare weight, net weight, material, grade, seller/supplier name, vehicle number and ticket number. Copy numbers exactly.' },
          { type: 'image', image: `data:${mimeType};base64,${imageBase64}` },
        ],
      },
    ],
  });
  return object;
}

export interface WeighbridgeIntakeResult {
  ok: boolean;
  reply: string;
  ticket: WeighbridgeTicket;
  decision?: 'auto' | 'ask' | 'deny';
  approvalId?: string;
  entryId?: string;
  rate?: number;
  error?: string;
}

function kg(n: number | null): string {
  return n != null ? `${n.toLocaleString('en-IN')} kg` : '?';
}

/** Grade → day's rate: from the item master (scrap items carry data.grade + stdRate). Matching ignores spaces/hyphens/case ("MS solid" = "MS-solid"). */
export async function gradeRate(orgId: string, grade: string | null, material: string | null): Promise<{ rate: number | null; itemId: string | null; itemLabel: string | null }> {
  if (!grade && !material) return { rate: null, itemId: null, itemLabel: null };
  const term = grade ?? material!;
  const rows = await query<{ id: string; name: string | null; rate: string | null }>(
    `select id, coalesce(name, data->>'name') as name, data->>'stdRate' as rate
     from entities
     where org_id = $1 and type = 'item'
       and (
         regexp_replace(coalesce(data->>'grade',''), '[^a-zA-Z0-9]', '', 'g') ilike regexp_replace($2, '[^a-zA-Z0-9]', '', 'g') || '%'
         or regexp_replace(coalesce(name, data->>'name',''), '[^a-zA-Z0-9]', '', 'g') ilike '%' || regexp_replace($2, '[^a-zA-Z0-9]', '', 'g') || '%'
       )
     limit 1`,
    [orgId, term]
  );
  const r = rows[0];
  if (!r) return { rate: null, itemId: null, itemLabel: null };
  return { rate: r.rate ? Number(r.rate) : null, itemId: r.id, itemLabel: r.name };
}

/**
 * Full intake: match seller + grade rate, draft the purchase entry via policy,
 * record the activity entry, and return a WhatsApp-ready summary.
 */
export async function processWeighbridgeTicket(
  orgId: string,
  ticket: WeighbridgeTicket,
  meta: { from?: string; via: 'whatsapp-text' | 'whatsapp-photo' | 'web' }
): Promise<WeighbridgeIntakeResult> {
  if (ticket.netKg == null || ticket.netKg <= 0) {
    return {
      ok: false,
      ticket,
      reply: 'I could not read a valid net weight. Please send: gross, tare and grade — e.g. "gross 5420 tare 1220 grade MS solid from Ramesh".',
      error: 'net weight missing',
    };
  }

  // seller match (small sellers are parties with kind='vendor')
  let seller: { id: string; name: string } | null = null;
  if (ticket.sellerName) {
    const rows = await query<{ id: string; name: string }>(
      `select id, coalesce(name, data->>'name') as name from entities
       where org_id = $1 and type = 'party' and coalesce(data->>'kind','vendor') in ('vendor','seller')
         and coalesce(name, data->>'name') ilike $2 limit 1`,
      [orgId, `%${ticket.sellerName}%`]
    );
    seller = rows[0] ?? null;
  }

  const rateInfo = await gradeRate(orgId, ticket.grade, ticket.material);
  const rate = rateInfo.rate;
  const amount = rate != null ? Math.round(ticket.netKg * rate) : null;

  const sources: ActionSource[] = [
    { type: 'message', label: meta.via === 'whatsapp-photo' ? `Weighbridge ticket photo (WhatsApp${meta.from ? `, ${meta.from}` : ''})` : `Weighbridge details (WhatsApp text${meta.from ? `, ${meta.from}` : ''})` },
  ];
  if (rateInfo.itemLabel) sources.push({ type: 'item', label: `Rate card: ${rateInfo.itemLabel} @ ₹${rate}/kg`, ref: rateInfo.itemId ?? undefined });
  if (seller) sources.push({ type: 'party', label: `Seller: ${seller.name}`, ref: seller.id });
  if (ticket.ticketNo) sources.push({ type: 'document', label: `Ticket ${ticket.ticketNo}` });

  const summaryBits = [
    `${kg(ticket.netKg)} of ${ticket.grade ?? ticket.material ?? 'scrap'} from ${seller?.name ?? ticket.sellerName ?? 'unnamed seller'}`,
    rate != null ? `at ₹${rate}/kg = ₹{amount}` : '',
  ];
  const summary = summaryBits.filter(Boolean).join(' ').replace('{amount}', amount ? Number(amount).toLocaleString('en-IN') : '?');
  const reason = rate == null
    ? 'No grade rate found in the rate card — the entry is drafted at zero rate for you to set.'
    : `Rate taken from today's ${ticket.grade ?? ticket.material ?? ''} card.`;

  if (!seller) {
    // unknown seller: still draft, flag prominently
  }

  const payload = {
    sellerId: seller?.id,
    seller: seller?.name ?? ticket.sellerName ?? 'Unknown seller',
    itemId: rateInfo.itemId,
    item: rateInfo.itemLabel ?? ticket.grade ?? ticket.material ?? 'scrap',
    grade: ticket.grade,
    netKg: ticket.netKg,
    grossKg: ticket.grossKg,
    tareKg: ticket.tareKg,
    rate: rate ?? 0,
    amount: amount ?? 0,
    ticketNo: ticket.ticketNo,
    vehicleNo: ticket.vehicleNo,
    date: ticket.date ?? new Date().toISOString().slice(0, 10),
    via: meta.via,
  };

  const r = await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'weighbridge_entry',
      entityType: 'purchase_entry',
      payload,
      preview: `Draft purchase: ${summary}${ticket.ticketNo ? ` (ticket ${ticket.ticketNo})` : ''}${rate == null ? ' — RATE MISSING, please set' : ''}`,
      risk: 'write',
    },
    (pl) => executeAction(orgId, 'weighbridge_entry', pl as Record<string, unknown>)
  );

  // the trust layer: a queued draft appears on the timeline immediately,
  // before any approval — owners see what the agent is about to do
  if (r.decision === 'ask') {
    try {
      const { recordAgentAction } = await import('./activity.js');
      await recordAgentAction({
        orgId,
        actionType: 'weighbridge_entry',
        summary: `Drafted purchase entry — ${summary}${ticket.ticketNo ? ` (ticket ${ticket.ticketNo})` : ''} — waiting for your approval`,
        reason,
        sources,
        entityType: 'purchase_entry',
        status: 'awaiting_approval',
        metadata: { approvalId: r.approvalId, via: meta.via },
      });
    } catch {
      // timeline is best-effort at proposal time
    }
  }

  await audit(orgId, 'agent', 'weighbridge.intake', {
    metadata: { ticket: ticket.ticketNo, net: ticket.netKg, grade: ticket.grade, decision: r.decision, via: meta.via },
  });

  const reply = [
    `⚖️ Weighed in: *${kg(ticket.netKg)}* of ${ticket.grade ?? ticket.material ?? 'scrap'}`,
    seller ? `Seller: ${seller.name}` : `⚠️ Seller "${ticket.sellerName ?? '?'}" not in the master — tell me the right name and I'll update.`,
    rate != null ? `Rate: ₹${rate}/kg → ₹${Number(amount).toLocaleString('en-IN')}` : '⚠️ No rate found for this grade — the entry is drafted with rate 0, please confirm the rate.',
    r.decision === 'auto'
      ? '✅ Entry recorded.'
      : r.decision === 'ask'
        ? '🕓 Drafted — waiting for your approval. Send *pending* to see it, or approve from the AI Activity page.'
        : '🚫 Blocked by your guardrail settings.',
  ].join('\n');

  return { ok: r.decision !== 'deny', reply, ticket, decision: r.decision, approvalId: r.approvalId, rate: rate ?? undefined };
}

/** Looks like a weighbridge text? (cheap pre-filter before full parse) */
export function looksLikeWeighbridgeText(text: string): boolean {
  return /gross\s*[:\-]?\s*\d|tare\s*[:\-]?\s*\d|weighbridge|wb\s*no/i.test(text);
}
