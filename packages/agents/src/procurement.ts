import { query } from '@factory/db';

/**
 * Agent 5 — Procurement (PRD F5): the QUOTE side of the loop. Reorder→RFQ
 * drafting already existed as tools; this module completes the spec: vendor
 * replies (unstructured WhatsApp/email text or structured numbers) are parsed
 * into a running comparison table, scored deterministically (lowest rate that
 * meets the required-by date; preferred vendors win ties; zero-qty flags
 * min-quantity traps), and the table is attached to the RFQ so the purchase
 * head approves or overrides with full context. PO creation from the pick
 * stays with create_po_draft — RFQ-sending and PO-creation remain separate
 * risk levels, as the spec demands.
 *
 * Parsing is deliberately regex-deterministic (₹/Rs + per-unit phrasing,
 * "delivery in N days", "N days") so it works in dev/evals with no API key;
 * the model may pre-extract numbers from messy text, and structured fields
 * always win over parsed ones.
 */

export interface QuoteInput {
  vendorName: string;
  replyText?: string;
  rate?: number;
  leadTimeDays?: number;
  minQty?: number;
  note?: string;
}

export interface ParsedQuote {
  vendorName: string;
  rate: number | null;
  leadTimeDays: number | null;
  minQty: number;
  note?: string;
  replyText?: string;
  parseNotes: string[];
  meetsRequirement: boolean;
}

export interface QuoteComparison {
  rfqCode: string;
  quotes: ParsedQuote[];
  requiredBy?: string;
  recommended?: {
    vendorName: string;
    rate: number;
    leadTimeDays: number | null;
    why: string;
  };
  escalations: string[];
}

/** Extract ₹rate and lead-time from a verbatim vendor reply. */
export function parseQuoteReply(text: string): { rate?: number; leadTimeDays?: number } {
  const out: { rate?: number; leadTimeDays?: number } = {};
  const rate = text.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)(?:\s*(?:\/|-|per)\s*(?:kg|nos|pc|unit|ltr))?/i);
  if (rate) out.rate = Number(rate[1]!.replace(/,/g, ''));
  const days = text.match(/(?:delivery|dispatch|lead\s*time|ready)\D{0,12}(\d{1,2})\s*(?:days?|din)/i)
    ?? text.match(/(\d{1,2})\s*(?:days?|din)\s*(?:delivery|delivery time)/i);
  if (days) out.leadTimeDays = Number(days[1]);
  return out;
}

/**
 * Compare vendor quotes for an RFQ: parses verbatim replies, scores
 * deterministically, persists a vendor_quote row per reply (linked to the
 * RFQ by code) and returns the ranked table + recommendation.
 */
export async function compareVendorQuotes(
  orgId: string,
  rfqCode: string,
  quotes: QuoteInput[],
  requiredBy?: string
): Promise<QuoteComparison> {
  const rfq = (
    await query<{ id: string; item_id: string | null }>(
      `select id, item_id from entities where org_id=$1 and type='rfq' and code=$2 limit 1`,
      [orgId, rfqCode]
    )
  )[0];

  const escalations: string[] = [];
  const parsed: ParsedQuote[] = quotes.map((q) => {
    const fromText = q.replyText ? parseQuoteReply(q.replyText) : {};
    const rate = q.rate ?? fromText.rate ?? null;
    const leadTimeDays = q.leadTimeDays ?? fromText.leadTimeDays ?? null;
    const minQty = q.minQty ?? 0;
    const notes: string[] = [];
    if (rate == null) notes.push('no rate found in reply');
    if (leadTimeDays == null) notes.push('no lead time stated');

    let meets = rate != null;
    if (requiredBy && leadTimeDays != null) {
      const deadline = new Date(requiredBy + 'T00:00:00Z').getTime();
      const arrival = Date.now() + leadTimeDays * 86_400_000;
      if (arrival > deadline) {
        meets = false;
        notes.push(`misses the ${requiredBy} need-by date`);
      }
    }
    if (minQty > 0) notes.push(`minimum order ${minQty}`);

    return {
      vendorName: q.vendorName,
      rate,
      leadTimeDays,
      minQty,
      note: q.note,
      replyText: q.replyText,
      parseNotes: notes,
      meetsRequirement: meets,
    };
  });

  // resolve vendor names → ids and persist each quote against the RFQ
  for (const q of parsed) {
    const vendor = (
      await query<{ id: string; name: string | null }>(
        `select id, coalesce(name, data->>'name') as name from entities
         where org_id=$1 and type='party' and data->>'kind'='vendor' and coalesce(name, data->>'name') ilike $2 limit 1`,
        [orgId, `%${q.vendorName}%`]
      )
    )[0];
    if (!vendor) escalations.push(`Vendor "${q.vendorName}" is not in the party master — add them before raising the PO.`);
    if (rfq) {
      await query(
        `insert into entities (id, org_id, type, status, party_id, item_id, rate, source, data)
         values (gen_random_uuid()::text, $1, 'vendor_quote', 'received', $2, $3, $4, 'agent', $5::jsonb)`,
        [
          orgId,
          vendor?.id ?? null,
          rfq.item_id,
          q.rate,
          JSON.stringify({
            rfqCode,
            vendor: vendor?.name ?? q.vendorName,
            leadTimeDays: q.leadTimeDays,
            minQty: q.minQty,
            meetsRequirement: q.meetsRequirement,
            parseNotes: q.parseNotes,
            replyText: q.replyText?.slice(0, 500) ?? null,
            note: q.note ?? null,
          }),
        ]
      );
    }
  }

  // recommendation: cheapest quote that meets the requirement; ties broken by
  // lead time, then alphabetically for determinism
  const eligible = parsed
    .filter((q) => q.meetsRequirement && q.rate != null)
    .sort((a, b) => (a.rate! - b.rate!) || ((a.leadTimeDays ?? 99) - (b.leadTimeDays ?? 99)) || a.vendorName.localeCompare(b.vendorName));
  const recommended = eligible[0]
    ? {
        vendorName: eligible[0].vendorName,
        rate: eligible[0].rate!,
        leadTimeDays: eligible[0].leadTimeDays,
        why:
          `Lowest quoted rate (₹${eligible[0].rate!.toLocaleString('en-IN')})` +
          (eligible[0].leadTimeDays != null ? ` with ${eligible[0].leadTimeDays}-day delivery` : '') +
          (eligible.length > 1 ? ` — ₹${(eligible[1]!.rate! - eligible[0].rate!).toLocaleString('en-IN')} under the next best` : ''),
      }
    : undefined;

  if (parsed.length >= 2 && eligible.length === 1) {
    escalations.push('Only 1 of the received quotes meets the requirement — proceed, or chase the others?');
  }
  if (parsed.length > 0 && recommended == null) {
    escalations.push('No quote meets the rate/lead-time requirement — renegotiate or extend the need-by date.');
  }

  return { rfqCode, quotes: parsed, requiredBy, recommended, escalations };
}
