import type { ExtractedPo } from '@factory/agents';

/**
 * A2 golden DOCUMENT set (spec done-when: "field-level extraction accuracy
 * ≥95% on a golden document set before auto-processing is allowed for any
 * org"). Each doc is a labelled, real-world-shaped document; benchmark.ts
 * scores extraction field-by-field and gates the auto-processing threshold.
 * Add documents as pilot paperwork accumulates — the set is the regression
 * harness for prompt/model changes.
 */

/** ground truth (Partial = field absent in the source; minLines = expected line-count floor) */
export type GoldenExpected = Partial<ExtractedPo> & { minLines?: number };

export interface GoldenDocument {
  name: string;
  /** document text exactly as it would arrive (WhatsApp paste / email body / typed) */
  text: string;
  /** ground truth (Partial = field absent in the source) */
  expected: GoldenExpected;
}

export const GOLDEN_DOCUMENTS: GoldenDocument[] = [
  {
    name: 'po-fabrication-typed',
    text: `PURCHASE ORDER
PO No: PO-7841        Date: 20/09/2026
To: Precision Metalworks, Peenya
From: Shakti Industries
GSTIN: 29ABCDE1234F1Z5
1. MS Bracket 200mm x 200 nos @ 240
2. SS Enclosure 4U x 20 nos @ 1850
Delivery: 15/10/2026
Total: 85000`,
    expected: { poNumber: 'PO-7841', customerName: 'Shakti Industries', totalAmount: 85000, minLines: 2 },
  },
  {
    name: 'po-hinglish-whatsapp',
    text: `bhai order confirm karo
PO 7842 - Sundaram Traders
MS Bracket 200mm 50 pcs, rate 240
total 12000
jaldi bhejna`,
    expected: { poNumber: 'PO-7842', customerName: 'Sundaram Traders', totalAmount: 12000, minLines: 1 },
  },
  {
    name: 'invoice-tax',
    text: `TAX INVOICE
Invoice No: INV-3301        Dt: 05.10.2026
M/s Fine Engineering Works
Item: Laser-cut Plate 6mm
Qty: 40 nos   Rate: Rs 620/- each
CGST 9%  SGST 9%
Grand Total: Rs 27,104`,
    expected: { poNumber: 'INV-3301', customerName: 'Fine Engineering Works', totalAmount: 27104, minLines: 1 },
  },
  {
    name: 'challan-jobwork',
    text: `JOB WORK CHALLAN
Challan No: JC/2219  dated 02-10-2026
Party: Rao Metal Works
Weldment Frame A - 12 nos for powder coating
Amount: 15600`,
    expected: { poNumber: 'JC/2219', customerName: 'Rao Metal Works', totalAmount: 15600 },
  },
  {
    name: 'quote-proforma',
    text: `PROFORMA INVOICE / QUOTATION
Quote No: Q-918
Date: 2026-09-28
Customer: Sundaram Traders
Conveyor Roller  x 30 @ 1450
Terms: 50% advance
Total: 43500`,
    expected: { poNumber: 'Q-918', customerName: 'Sundaram Traders', totalAmount: 43500 },
  },
  {
    name: 'po-scrap-kgs',
    text: `Order sheet
PO: 7750
Buyer: Greencycle Traders
MS Turnings 1200 kg @ 22
Amount payable: 26400`,
    expected: { poNumber: 'PO-7750', customerName: 'Greencycle Traders', totalAmount: 26400 },
  },
  {
    name: 'po-multiline-runs',
    text: `Purchase Order No. PO-9901 dated 12/09/2026
Shakti Industries orders:
MS Bracket 200mm 100 nos @ 240 = 24000
SS Enclosure 4U 10 nos @ 1850 = 18500
Conveyor Roller 5 nos @ 2100 = 10500
Total Value 53000`,
    expected: { poNumber: 'PO-9901', customerName: 'Shakti Industries', totalAmount: 53000, minLines: 3 },
  },
  {
    name: 'po-missing-gstin-still-parses',
    text: `PO 8830
Meena Enterprises
Pickle Jar 500g, 300 nos, rate 58
Total 17400`,
    expected: { poNumber: 'PO-8830', customerName: 'Meena Enterprises', totalAmount: 17400 },
  },
  // below-threshold cases: deliberately bad/unreadable, must be flagged for review
  {
    name: 'garbage-incomplete',
    text: 'pls send soon. material urgent.',
    expected: {},
  },
  {
    name: 'po-illegible-amount',
    text: `PO 4412 from Naik Traders
MS Bracket 200mm qty 80
total ?? (rate not written)`,
    expected: { poNumber: 'PO-4412' },
  },
];
