import { query, audit } from '@factory/db';
import { getGspProvider, EWbSchema } from '@factory/connectors';
import { recordAgentAction } from './activity.js';

/**
 * E-way bill flow (next to IRN generation): on dispatch, capture vehicle
 * number + from/to pincodes → generate the EWb via the GSP → store the
 * number + validity on the invoice. EWB_NOTE: the sandbox provider
 * generates a deterministic number; live GSPs require the IRN for
 * Part-A, so generateEInvoice should run first (the API enforces order).
 */

export interface EWbStatus {
  invoice: string | null;
  generated: boolean;
  ewbNo?: string;
  validUntil?: string;
  provider?: string;
  error?: string;
}

export async function generateEWayBill(
  orgId: string,
  invoiceCode: string,
  input: { vehicleNumber: string; fromPincode: string; toPincode: string; transporterName?: string },
  actor = 'agent'
): Promise<EWbStatus> {
  const rows = await query<{
    id: string; code: string | null; date: string; amount: string; party_id: string | null;
    data: Record<string, unknown>;
  }>(
    `select id, code, date::text, amount, party_id, data from entities
     where org_id = $1 and type = 'invoice' and code = $2 limit 1`,
    [orgId, invoiceCode]
  );
  const inv = rows[0];
  if (!inv) return { invoice: invoiceCode, generated: false, error: 'invoice not found' };

  const d = (inv.data ?? {}) as Record<string, string | undefined>;
  if (!d.irn) return { invoice: inv.code, generated: false, error: 'Generate the IRN first — an e-way bill Part-A needs a registered invoice.' };
  if (d.ewbNo) return { invoice: inv.code, generated: true, ewbNo: d.ewbNo, validUntil: d.ewbValidUntil, provider: d.ewbProvider };

  const org = await query<{ settings: Record<string, unknown>; name: string }>('select settings, name from organizations where id = $1 limit 1', [orgId]);
  const sellerGstin = String((org[0]?.settings ?? {}).gstin ?? '');
  const buyer = await query<{ gstin: string | null; name: string | null; pincode: string | null }>(
    `select data->>'gstin' as gstin, coalesce(name, data->>'name') as name, data->>'pincode' as pincode
     from entities where id = $1 limit 1`,
    [inv.party_id]
  );
  const buyerGstin = buyer[0]?.gstin ?? '';
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(sellerGstin) || !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(buyerGstin)) {
    return { invoice: inv.code, generated: false, error: 'Both seller and buyer GSTINs are needed for an e-way bill.' };
  }
  const toPin = input.toPincode || buyer[0]?.pincode || '';
  if (!/^\d{6}$/.test(input.fromPincode) || !/^\d{6}$/.test(toPin)) {
    return { invoice: inv.code, generated: false, error: 'Both from and to pincodes (6 digits) are required for the e-way bill.' };
  }
  if (!/^[A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{3,4}$/i.test(input.vehicleNumber)) {
    return { invoice: inv.code, generated: false, error: 'Vehicle number looks wrong — expected something like MH12AB1234.' };
  }

  const amount = Number(inv.amount ?? 0);
  const sellerState = sellerGstin.slice(0, 2);
  const buyerState = buyerGstin.slice(0, 2);
  const ewbInput = EWbSchema.parse({
    userGstin: sellerGstin,
    invoiceNumber: inv.code ?? inv.id,
    invoiceDate: inv.date,
    transactionType: 'outward',
    supplyType: sellerState === buyerState ? 'intra-state' : 'inter-state',
    transporterName: input.transporterName,
    vehicleNumber: input.vehicleNumber.toUpperCase(),
    fromPincode: input.fromPincode,
    toPincode: toPin,
    value: amount,
    docType: 'INV',
  });

  const provider = getGspProvider();
  let result;
  try {
    result = await provider.generateEWayBill(ewbInput);
  } catch (e) {
    return { invoice: inv.code, generated: false, error: `GSP call failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 240) };
  }

  await query(
    `update entities set data = data || $3::jsonb where org_id = $1 and id = $2`,
    [orgId, inv.id, JSON.stringify({
      ewbNo: result.ewbNo,
      ewbValidUntil: result.validUntil,
      ewbProvider: result.provider,
      ewbVehicle: input.vehicleNumber.toUpperCase(),
      ewbFromPin: input.fromPincode,
      ewbToPin: toPin,
      ewaybilled: true,
    })]
  );
  await audit(orgId, actor, 'einvoicing.ewb_generated', {
    entityType: 'invoice', entityId: inv.id,
    metadata: { invoice: inv.code, ewbNo: result.ewbNo, vehicle: input.vehicleNumber },
  });
  try {
    await recordAgentAction({
      orgId,
      actor,
      actionType: 'einvoicing',
      summary: `Generated e-way bill ${result.ewbNo} for ${inv.code} — vehicle ${input.vehicleNumber.toUpperCase()}, ${input.fromPincode} → ${toPin}`,
      reason: 'Dispatch captured; EWB valid 18 hours from generation',
      sources: [
        { type: 'invoice', label: `Invoice ${inv.code} (IRN registered)`, ref: inv.id },
        { type: 'document', label: `Vehicle ${input.vehicleNumber.toUpperCase()}` },
      ],
      entityType: 'invoice',
      entityId: inv.id,
      status: 'executed',
      metadata: { ewbNo: result.ewbNo },
    });
  } catch {
    // best-effort
  }

  return { invoice: inv.code, generated: true, ewbNo: result.ewbNo, validUntil: result.validUntil, provider: result.provider };
}
