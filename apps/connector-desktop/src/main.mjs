#!/usr/bin/env node
/**
 * Factory AI OS — Tally desktop connector (PRD C-4).
 * Outbound-only HTTPS to the API with a device token. Pulls masters/vouchers
 * from Tally's XML-over-HTTP interface, pushes approved vouchers, heartbeats.
 */

const API = process.env.FACTORY_API ?? 'http://localhost:3100';
const CONNECTOR_ID = process.env.FACTORY_CONNECTOR_ID ?? '';
const DEVICE_TOKEN = process.env.FACTORY_DEVICE_TOKEN ?? '';
const TALLY_HOST = process.env.TALLY_HOST ?? 'localhost';
const TALLY_PORT = Number(process.env.TALLY_PORT ?? 9000);
const TALLY_COMPANY = process.env.TALLY_COMPANY ?? '';
const HEARTBEAT_MS = 30_000;
const RETRY_BACKOFF = [1_000, 5_000, 15_000, 60_000];

let lastAlterId = 0;
let backoffIdx = 0;
let running = true;

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

async function api(op, body) {
  const res = await fetch(`${API}/api/connector/${CONNECTOR_ID}?op=${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': DEVICE_TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${op} failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function tally(xml) {
  const res = await fetch(`http://${TALLY_HOST}:${TALLY_PORT}`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml;charset=utf-8' },
    body: xml,
  });
  if (!res.ok) throw new Error(`Tally HTTP ${res.status} — is Tally Prime running with XML interface enabled?`);
  return res.text();
}

// --- XML (mirrors packages/connectors/src/tally/xml.ts) ----------------------

function tag(text, name) {
  const m = text.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

function mastersRequest() {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER><BODY><DESC><REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${TALLY_COMPANY}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

function stockItemsRequest() {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER><BODY><DESC><REPORTNAME>List of Stock Items</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${TALLY_COMPANY}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

// --- Sync steps ---------------------------------------------------------------

async function pullMasters() {
  const [ledgersXml, itemsXml] = await Promise.all([tally(mastersRequest()), tally(stockItemsRequest())]);
  const records = [];

  for (const block of ledgersXml.split(/<LEDGER\b/i).slice(1)) {
    const b = block.split('</LEDGER>')[0] ?? '';
    const name = tag(b, 'NAME');
    if (!name) continue;
    records.push({
      sourceId: `ledger:${tag(b, 'GUID') ?? name}`,
      type: 'party',
      name,
      code: name,
      data: { parent: tag(b, 'PARENT'), gstin: tag(b, 'PARTYGBSTIN') ?? undefined, alterId: Number(tag(b, 'ALTERID') ?? 0) },
    });
    const aid = Number(tag(b, 'ALTERID') ?? 0);
    if (aid > lastAlterId) lastAlterId = aid;
  }

  for (const block of itemsXml.split(/<STOCKITEM\b/i).slice(1)) {
    const b = block.split('</STOCKITEM>')[0] ?? '';
    const name = tag(b, 'NAME');
    if (!name) continue;
    records.push({
      sourceId: `item:${tag(b, 'GUID') ?? name}`,
      type: 'item',
      name,
      code: name,
      data: { baseUnit: tag(b, 'BASEUNITS'), alterId: Number(tag(b, 'ALTERID') ?? 0) },
    });
  }

  if (records.length) await api('pull', { records });
  return records.length;
}

async function pushApproved() {
  // heartbeat returns queued, APPROVED pushes; execute each against Tally
  const res = await api('heartbeat', { status: 'connected' });
  const acks = [];
  for (const push of res.pendingPushes ?? []) {
    try {
      const payload = typeof push.body === 'string' ? JSON.parse(push.body || '{}') : (push.body ?? {});
      const xml = buildVoucherXml(payload);
      await tally(xml);
      acks.push({ sourceId: push.id, ok: true });
      log(`pushed ${payload.voucherType ?? 'voucher'} ${payload.voucherNo ?? push.id}${push.source === 'approval' ? ' (approved)' : ''}`);
    } catch (e) {
      acks.push({ sourceId: push.id, ok: false, error: String(e.message ?? e) });
      log('push failed', e.message ?? e);
    }
  }
  if (acks.length) await api('ack', { acks });
  return acks.length;
}

function buildVoucherXml(payload) {
  const type = payload.voucherType ?? 'Purchase';
  const party = payload.partyLedger ?? payload.vendorName ?? payload.vendor ?? '';
  // single-item pushes (agent-created POs) become one inventory line
  const lines = (payload.lines ?? (payload.item ? [{ item: payload.itemName ?? payload.item, qty: payload.qty, rate: payload.rate, uom: payload.uom }] : [])).map((l) =>
    `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${l.item ?? l.itemName ?? ''}</STOCKITEMNAME><RATE>${l.rate ?? 0}</RATE><AMOUNT>${l.amount ?? (l.qty ?? 0) * (l.rate ?? 0)}</AMOUNT><ACTUALQTY>${l.qty ?? 0} ${l.uom ?? ''}</ACTUALQTY></ALLINVENTORYENTRIES.LIST>`
  ).join('');
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${TALLY_COMPANY}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE><VOUCHER VCHTYPE="${type}" ACTION="Create"><DATE>${(payload.date ?? new Date().toISOString().slice(0, 10)).replaceAll('-', '')}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${payload.voucherNo ?? ''}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><NARRATION>Imported by Factory AI OS (approved)</NARRATION>${lines}</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

async function withBackoff(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn();
      backoffIdx = 0;
      return r;
    } catch (e) {
      const wait = RETRY_BACKOFF[Math.min(attempt, RETRY_BACKOFF.length - 1)] ?? 60_000;
      log(`error: ${e.message ?? e} — retrying in ${wait / 1000}s`);
      await api('heartbeat', { status: 'error', error: String(e.message ?? e).slice(0, 300) }).catch(() => {});
      await new Promise((r) => setTimeout(r, wait));
      if (attempt > 10) throw e;
    }
  }
}

async function cycle() {
  await withBackoff(async () => {
    const pulled = await pullMasters();
    const pushed = await pushApproved();
    log(`cycle ok — pulled ${pulled} masters, pushed ${pushed} vouchers`);
  });
}

// main loop
process.on('SIGINT', () => { running = false; process.exit(0); });

if (!CONNECTOR_ID || !DEVICE_TOKEN) {
  console.error('Set FACTORY_CONNECTOR_ID and FACTORY_DEVICE_TOKEN (see README).');
  process.exit(1);
}

log(`connector starting — API ${API}, Tally ${TALLY_HOST}:${TALLY_PORT}, company "${TALLY_COMPANY}"`);
cycle();
const timer = setInterval(() => { if (running) cycle().catch((e) => log('cycle error', e.message ?? e)); }, HEARTBEAT_MS);
