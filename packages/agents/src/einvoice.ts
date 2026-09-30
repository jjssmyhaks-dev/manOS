import { query, audit } from '@factory/db';
import { getGspProvider, EInvoiceSchema } from '@factory/connectors';
import { recordAgentAction } from './activity.js';

/**
 * E-invoice flow (PRD C-3 + P2 F11, wired end to end): on a dispatched/B2B
 * invoice the agent builds the IRN payload from the invoice + party master,
 * calls the GSP behind the provider interface (sandbox in dev, GSTZen-class
 * in prod), and stores the IRN + ack + signed QR on the invoice so the UI,
 * digests and Tally exports all see the same truth. Generation is
 * idempotent — a second call returns the existing IRN, never a duplicate.
 */

export interface EInvoiceStatus {
  invoice: string | null;
  einvoiced: boolean;
  irn?: string;
  ackNo?: string;
  ackDate?: string;
  qr?: string;
  provider?: string;
  generatedAt?: string;
  error?: string;
}

interface InvoiceRow {
  id: string;
  code: string | null;
  date: string;
  amount: string;
  party_id: string | null;
  customer: string | null;
  buyer_gstin: string | null;
  item: string | null;
  gst_rate: string | null;
  existing: Record<string, unknown> | null;
}

async function loadInvoice(orgId: string, invoiceCode: string): Promise<InvoiceRow | null> {
  const rows = await query<InvoiceRow>(
    `select e.id, e.code, e.date::text, e.amount, e.party_id, e.data as existing,
            coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), '(unknown)') as customer,
            (select p.data->>'gstin' from entities p where p.id = e.party_id) as buyer_gstin,
            coalesce((select coalesce(i.name, i.data->>'name') from entities i where i.id = e.item_id), 'Goods') as item,
            (select i.data->>'gstRate' from entities i where i.id = e.item_id) as gst_rate
     from entities e
     where e.org_id = $1 and e.type = 'invoice' and e.code = $2
     limit 1`,
    [orgId, invoiceCode]
  );
  return rows[0] ?? null;
}

/** Status for the UI (no generation). */
export async function eInvoiceStatus(orgId: string, invoiceCode: string): Promise<EInvoiceStatus> {
  const inv = await loadInvoice(orgId, invoiceCode);
  if (!inv) return { invoice: invoiceCode, einvoiced: false, error: 'invoice not found' };
  const d = (inv.existing ?? {}) as Record<string, string | undefined>;
  if (!d.irn) return { invoice: inv.code, einvoiced: false };
  return {
    invoice: inv.code,
    einvoiced: true,
    irn: d.irn,
    ackNo: d.irnAckNo,
    ackDate: d.irnAckDate,
    qr: d.irnQr,
    provider: d.irnProvider,
    generatedAt: d.irnGeneratedAt,
  };
}

export interface GenerateResult extends EInvoiceStatus {
  ok: boolean;
  alreadyGenerated?: boolean;
}

export async function generateEInvoice(orgId: string, invoiceCode: string, actor = 'agent'): Promise<GenerateResult> {
  const inv = await loadInvoice(orgId, invoiceCode);
  if (!inv) return { ok: false, invoice: invoiceCode, einvoiced: false, error: 'invoice not found' };

  const d = (inv.existing ?? {}) as Record<string, string | undefined>;
  if (d.irn) {
    return { ok: true, invoice: inv.code, einvoiced: true, alreadyGenerated: true, irn: d.irn, ackNo: d.irnAckNo, ackDate: d.irnAckDate, qr: d.irnQr, provider: d.irnProvider, generatedAt: d.irnGeneratedAt };
  }

  // seller GSTIN: operator-configured on the org settings
  const org = await query<{ settings: Record<string, unknown>; name: string }>('select settings, name from organizations where id = $1 limit 1', [orgId]);
  const sellerGstin = String((org[0]?.settings ?? {} as Record<string, unknown>).gstin ?? '');
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(sellerGstin)) {
    return { ok: false, invoice: inv.code, einvoiced: false, error: 'Your own GSTIN is not set — add it in organisation settings (settings.gstin) before generating e-invoices.' };
  }
  if (!inv.buyer_gstin || !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(inv.buyer_gstin)) {
    return { ok: false, invoice: inv.code, einvoiced: false, error: `Buyer ${inv.customer} has no valid GSTIN on file — e-invoice applies to B2B supplies. Add it on the party record.` };
  }

  const amount = Number(inv.amount ?? 0);
  if (!(amount > 0)) return { ok: false, invoice: inv.code, einvoiced: false, error: 'Invoice amount is zero — nothing to register.' };

  const gstRate = inv.gst_rate ? Number(inv.gst_rate) : 18;
  const sellerState = sellerGstin.slice(0, 2);
  const buyerState = inv.buyer_gstin.slice(0, 2);
  const interState = sellerState !== buyerState;
  const taxable = amount;
  const taxAmt = Math.round(taxable * gstRate) / 100;

  const cgst = interState ? 0 : taxAmt;
  const sgst = interState ? 0 : taxAmt;
  const igst = interState ? taxAmt : 0;
  const input = EInvoiceSchema.parse({
    sellerGstin,
    buyerGstin: inv.buyer_gstin,
    invoiceNumber: inv.code ?? inv.id,
    invoiceDate: inv.date,
    value: taxable + cgst + sgst + igst,
    taxableValue: taxable,
    cgst,
    sgst,
    igst,
    placeOfSupply: buyerState,
    lines: [{ hsn: '8466', description: inv.item ?? 'Goods', qty: 1, rate: taxable, amount: taxable, gstRate }],
  });

  const provider = getGspProvider();
  let irnResult;
  try {
    irnResult = await provider.generateIrn(input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, invoice: inv.code, einvoiced: false, error: `GSP call failed: ${msg.slice(0, 200)}` };
  }

  const generatedAt = new Date().toISOString();
  await query(
    `update entities set data = data || $3::jsonb where org_id = $1 and id = $2`,
    [orgId, inv.id, JSON.stringify({
      irn: irnResult.irn,
      irnAckNo: irnResult.ackNo,
      irnAckDate: irnResult.ackDate,
      irnQr: irnResult.signedQr,
      irnProvider: irnResult.provider,
      irnGeneratedAt: generatedAt,
      einvoiced: true,
    })]
  );
  await audit(orgId, actor, 'einvoicing.irn_generated', {
    entityType: 'invoice', entityId: inv.id,
    metadata: { invoice: inv.code, irn: irnResult.irn.slice(0, 16) + '…', provider: irnResult.provider },
  });
  try {
    await recordAgentAction({
      orgId,
      actor,
      actionType: 'einvoicing',
      summary: `Generated e-invoice IRN for ${inv.code} — ${inv.customer}, ₹${amount.toLocaleString('en-IN')} (${interState ? 'IGST' : 'CGST+SGST'} @ ${gstRate}%) via ${irnResult.provider}`,
      reason: 'B2B invoice eligible for e-invoicing; IRN registered against the GST system',
      sources: [
        { type: 'invoice', label: `Invoice ${inv.code}`, ref: inv.id },
        { type: 'party', label: `Buyer GSTIN ${inv.buyer_gstin}` },
      ],
      entityType: 'invoice',
      entityId: inv.id,
      status: 'executed',
      metadata: { irn: irnResult.irn },
    });
  } catch {
    // activity is best-effort
  }

  return { ok: true, invoice: inv.code, einvoiced: true, irn: irnResult.irn, ackNo: irnResult.ackNo, ackDate: irnResult.ackDate, qr: irnResult.signedQr, provider: irnResult.provider, generatedAt };
}
