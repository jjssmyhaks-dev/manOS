/**
 * Tally Prime XML-over-HTTP protocol helpers (PRD C-4).
 * The desktop connector posts these to Tally at http://localhost:9000.
 * Tally stays the accounting source of truth: pull is incremental via
 * AlterID change markers; push happens only for approved vouchers; every
 * write is idempotent (source IDs) and audited.
 */

export interface TallyConnection {
  host: string; // e.g. localhost
  port: number; // default 9000
  company: string;
}

export const DEFAULT_TALLY_PORT = 9000;

// --- Pull: masters ----------------------------------------------------------

export function listCompaniesRequest(): string {
  return `<ENVELOPE><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>Display Path</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

export function mastersRequest(company: string, fromAlterId = 0): string {
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER>
<BODY><DESC><REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>20190401</SVFROMDATE><SVTODATE>20390401</SVTODATE>
</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

export function stockItemsRequest(company: string, fromAlterId = 0): string {
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER>
<BODY><DESC><REPORTNAME>List of Stock Items</REPORTNAME>
<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

export function vouchersRequest(company: string, fromDate: string, toDate: string): string {
  const from = toTallyDate(fromDate);
  const to = toTallyDate(toDate);
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER>
<BODY><DESC><REPORTNAME>Vouchers</REPORTNAME>
<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

// --- Push: voucher import -----------------------------------------------------

export function salesVoucherImport(v: {
  company?: string; voucherNo: string; date: string; partyLedger: string; partyGstin?: string;
  lines: Array<{ item: string; qty: number; rate: number; amount: number }>;
  totalAmount: number;
  narration?: string;
}): string {
  const d = toTallyDate(v.date);
  const entries = v.lines
    .map((l) => `        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>${escapeXml(l.item)}</STOCKITEMNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <RATE>${l.rate} Nos/1</RATE>
          <AMOUNT>${l.amount}</AMOUNT>
          <ACTUALQTY>${l.qty} Nos</ACTUALQTY>
          <BASICBUYERPRICE>${l.rate}</BASICBUYERPRICE>
        </ALLINVENTORYENTRIES.LIST>`)
    .join('\n');
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(v.company ?? '')}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">
  <DATE>${d}</DATE>
  <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${escapeXml(v.voucherNo)}</VOUCHERNUMBER>
  <PARTYLEDGERNAME>${escapeXml(v.partyLedger)}</PARTYLEDGERNAME>
  <PARTYNAME>${escapeXml(v.partyLedger)}</PARTYNAME>
  <NARRATION>${escapeXml(v.narration ?? 'Imported by Factory AI OS (approved)')}</NARRATION>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${escapeXml(v.partyLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <AMOUNT>-${v.totalAmount}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
${entries}
</VOUCHER>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

export function purchaseVoucherImport(v: {
  company: string; voucherNo: string; date: string; partyLedger: string;
  lines: Array<{ item: string; qty: number; rate: number; amount: number }>;
  totalAmount: number;
  narration?: string;
}): string {
  return salesVoucherImport({ ...v, narration: v.narration ?? 'Purchase imported by Factory AI OS (approved)' })
    .replace('VCHTYPE="Sales"', 'VCHTYPE="Purchase"')
    .replace('<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>', '<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>');
}

// --- Response parsing ----------------------------------------------------------

export interface TallyLedger {
  name: string;
  parent: string;
  alterId: number;
  guid: string;
  gstin?: string;
}

export interface TallyStockItem {
  name: string;
  baseUnit: string;
  alterId: number;
  guid: string;
}

export interface TallyVoucher {
  voucherType: string;
  voucherNumber: string;
  date: string;
  party: string;
  amount: number;
  alterId: number;
  guid: string;
}

/** Minimal, robust XML value finder (no DOM dependency). */
function tag(text: string, name: string): string | null {
  const m = text.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i'));
  return m ? m[1]!.trim() : null;
}

export function parseLedgers(xml: string): TallyLedger[] {
  const out: TallyLedger[] = [];
  const blocks = xml.split(/<LEDGER\b/i).slice(1);
  for (const b of blocks) {
    const block = b.split('</LEDGER>')[0] ?? '';
    const name = tag(block, 'NAME');
    if (!name) continue;
    out.push({
      name,
      parent: tag(block, 'PARENT') ?? 'Sundry Debtors',
      alterId: Number(tag(block, 'ALTERID') ?? 0),
      guid: tag(block, 'GUID') ?? '',
      gstin: tag(block, 'PARTYGBSTIN') ?? tag(block, 'GSTIN') ?? undefined,
    });
  }
  return out;
}

export function parseStockItems(xml: string): TallyStockItem[] {
  const out: TallyStockItem[] = [];
  const blocks = xml.split(/<STOCKITEM\b/i).slice(1);
  for (const b of blocks) {
    const block = b.split('</STOCKITEM>')[0] ?? '';
    const name = tag(block, 'NAME');
    if (!name) continue;
    out.push({
      name,
      baseUnit: tag(block, 'BASEUNITS') ?? 'nos',
      alterId: Number(tag(block, 'ALTERID') ?? 0),
      guid: tag(block, 'GUID') ?? '',
    });
  }
  return out;
}

export function parseVouchers(xml: string): TallyVoucher[] {
  const out: TallyVoucher[] = [];
  const blocks = xml.split(/<VOUCHER\b/i).slice(1);
  for (const b of blocks) {
    const block = b.split('</VOUCHER>')[0] ?? '';
    const type = tag(block, 'VOUCHERTYPENAME');
    const num = tag(block, 'VOUCHERNUMBER');
    if (!type || !num) continue;
    out.push({
      voucherType: type,
      voucherNumber: num,
      date: tag(block, 'DATE') ?? '',
      party: tag(block, 'PARTYLEDGERNAME') ?? '',
      amount: Math.abs(Number(tag(block, 'AMOUNT') ?? 0)),
      alterId: Number(tag(block, 'ALTERID') ?? 0),
      guid: tag(block, 'GUID') ?? '',
    });
  }
  return out;
}

export function parseCompanies(xml: string): string[] {
  const out: string[] = [];
  const re = /<NAME[^>]*>([^<]+)<\/NAME>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]!.trim());
  return [...new Set(out)];
}

export function toTallyDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}
