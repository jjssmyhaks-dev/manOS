import { z } from 'zod';

/**
 * e-Invoice / e-way bill via a GSP behind a provider interface (PRD C-3).
 * Develop against free sandboxes; swap provider by config, charge as pass-through.
 */

export const EInvoiceSchema = z.object({
  sellerGstin: z.string().length(15),
  buyerGstin: z.string().length(15),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string(),
  value: z.number().positive(),
  taxableValue: z.number().positive(),
  cgst: z.number().nonnegative().default(0),
  sgst: z.number().nonnegative().default(0),
  igst: z.number().nonnegative().default(0),
  placeOfSupply: z.string().length(2).describe('State code'),
  lines: z.array(z.object({
    hsn: z.string(),
    description: z.string(),
    qty: z.number().positive(),
    rate: z.number(),
    amount: z.number(),
    gstRate: z.number(),
  })).min(1),
});

export type EInvoiceInput = z.infer<typeof EInvoiceSchema>;

export const EWbSchema = z.object({
  userGstin: z.string().length(15),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  transactionType: z.enum(['outward', 'inward']),
  supplyType: z.enum(['intra-state', 'inter-state']),
  transporterId: z.string().optional(),
  transporterName: z.string().optional(),
  vehicleNumber: z.string().optional(),
  fromPincode: z.string().length(6),
  toPincode: z.string().length(6),
  value: z.number().positive(),
  docType: z.enum(['INV', 'CHL', 'BILL']).default('INV'),
});

export type EWbInput = z.infer<typeof EWbSchema>;

export interface IrnResult {
  irn: string;
  ackNo: string;
  ackDate: string;
  signedQr: string;
  provider: string;
}

export interface EWbResult {
  ewbNo: string;
  validUntil: string;
  provider: string;
}

export interface GspProvider {
  readonly name: string;
  readonly perEInvoiceInr: number;
  readonly perEWbInr: number;
  generateIrn(input: EInvoiceInput): Promise<IrnResult>;
  generateEWayBill(input: EWbInput): Promise<EWbResult>;
}

/** Sandbox stub — deterministic IRN for dev/evals; replace with real sandbox creds. */
export class SandboxGsp implements GspProvider {
  readonly name = 'sandbox';
  readonly perEInvoiceInr = 0;
  readonly perEWbInr = 0;

  async generateIrn(input: EInvoiceInput): Promise<IrnResult> {
    const seed = `${input.sellerGstin}${input.invoiceNumber}${input.invoiceDate}`;
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const irn = h.toString(16).padStart(12, '0').repeat(8).slice(0, 64);
    return {
      irn, ackNo: String(h).padStart(12, '0'), ackDate: new Date().toISOString(),
      signedQr: `sandbox-qr:${irn.slice(0, 24)}`, provider: this.name,
    };
  }

  async generateEWayBill(input: EWbInput): Promise<EWbResult> {
    let h = 7;
    for (const ch of input.invoiceNumber + input.userGstin) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
    return {
      ewbNo: String(h).padStart(12, '0'),
      validUntil: new Date(Date.now() + 18 * 3600_000).toISOString(),
      provider: this.name,
    };
  }
}

/** GSTZen (18p/e-invoice pooled) — sandbox stub; fill with real endpoint + key. */
export class GspZen implements GspProvider {
  readonly name = 'gstzen';
  readonly perEInvoiceInr = 0.18;
  readonly perEWbInr = 0.18;
  constructor(private apiKey: string, private baseUrl = 'https://sandbox-api.gstzen.in') {}

  async generateIrn(input: EInvoiceInput): Promise<IrnResult> {
    // Real integration: POST {baseUrl}/einvoice/v1/irn with API key; this stub defers.
    throw new Error(`GSTZen live call not configured (add sandbox credentials). Input validated: ${input.invoiceNumber}`);
  }
  async generateEWayBill(input: EWbInput): Promise<EWbResult> {
    throw new Error('GSTZen live call not configured (add sandbox credentials).');
  }
}

export function getGspProvider(name = process.env.GSP_PROVIDER ?? 'sandbox'): GspProvider {
  if (name === 'gstzen') return new GspZen(process.env.GSTZEN_API_KEY ?? '');
  return new SandboxGsp();
}
