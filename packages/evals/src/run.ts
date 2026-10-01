import {
  GOLDEN_CASES,
  type ExtractionCase,
  type MetricCase,
  type GuardrailCase,
  type ShadowModeCase,
  type EinvoiceCase,
  type EwbCase,
  type OverrideRateCase,
  type WeighbridgeCase,
  type RemediationCase,
  type QuoteComparisonCase,
  type CollectionsCase,
  type ShiftReportCase,
  type ComplianceThresholdCase,
  type MaintenanceCase,
} from './cases.js';

/**
 * Eval runner (PRD §6 evals + §17 definition of done):
 * every feature ships with an eval case; regression gate for prompt/model
 * changes. Uses the mock model + seed data so CI needs no keys.
 * Evals always run on a throwaway in-memory DB (FACTORY_DB_MEMORY=1),
 * never the developer's persistent dev store or the remote Neon database.
 *
 * The env var is set in a bootstrap entrypoint BEFORE any @factory/db import:
 * ESM hoists static imports above this file's body, and the db client decides
 * its engine at module load (adoptRootEnv walks up to the root .env.local).
 */
import './env.js';

interface Result {
  name: string;
  kind: string;
  pass: boolean;
  detail: string;
}

async function runExtraction(c: ExtractionCase): Promise<Result> {
  const { initDb, seedDemoData } = await import('@factory/db');
  const { extractDocument, validateExtraction } = await import('@factory/agents');
  const db = await initDb();
  await db.exec('select 1');
  const { orgId } = await seedDemoData('precision-metalworks');

  // run mock extraction (validate invariants without persisting twice)
  const res = await extractDocument(orgId, { text: c.input, source: 'upload' });
  const ex = res.extraction;
  const issues: string[] = [];

  if (c.expect.poNumber !== undefined && ex.poNumber !== c.expect.poNumber) {
    issues.push(`poNumber ${ex.poNumber} != ${c.expect.poNumber}`);
  }
  if (c.expect.customerName !== undefined && (ex.customerName ?? '') !== c.expect.customerName) {
    issues.push(`customerName ${ex.customerName} != ${c.expect.customerName}`);
  }
  if (c.expect.totalAmount !== undefined && ex.totalAmount !== c.expect.totalAmount) {
    issues.push(`totalAmount ${ex.totalAmount} != ${c.expect.totalAmount}`);
  }
  if (c.expect.minLines !== undefined && ex.lines.length < c.expect.minLines) {
    issues.push(`lines ${ex.lines.length} < ${c.expect.minLines}`);
  }
  if (c.expect.validationShouldFlag) {
    const v = validateExtraction(ex);
    if (v.length === 0) issues.push('expected validation issues, none found');
  }
  return { name: c.name, kind: c.kind, pass: issues.length === 0, detail: issues.join('; ') || 'ok' };
}

async function runMetricCase(c: MetricCase): Promise<Result> {
  const { seedDemoData, initDb } = await import('@factory/db');
  const { runMetric } = await import('@factory/agents');
  await initDb();
  const { orgId } = await seedDemoData(c.seedOrgSlug);
  const res = await runMetric(orgId, c.metricKey);
  const issues: string[] = [];
  if (c.expect.minValue !== undefined && (res.value ?? 0) < c.expect.minValue) {
    issues.push(`value ${res.value} < min ${c.expect.minValue}`);
  }
  if (c.expect.maxValue !== undefined && (res.value ?? 0) > c.expect.maxValue) {
    issues.push(`value ${res.value} > max ${c.expect.maxValue}`);
  }
  if (c.expect.exact !== undefined && res.value !== c.expect.exact) {
    issues.push(`value ${res.value} != ${c.expect.exact}`);
  }
  return { name: c.name, kind: c.kind, pass: issues.length === 0, detail: issues.join('; ') || `value=${res.value}` };
}

async function runGuardrail(c: GuardrailCase): Promise<Result> {
  const { isolateUntrusted } = await import('@factory/core');
  const { flagged } = isolateUntrusted('eval', c.text);
  return {
    name: c.name,
    kind: c.kind,
    pass: flagged === c.expectFlagged,
    detail: `flagged=${flagged}`,
  };
}

// --- pilot readiness: shadow mode --------------------------------------------

async function runShadowMode(_c: ShadowModeCase): Promise<Result> {
  const { initDb, seedDemoData, query } = await import('@factory/db');
  const { checkPolicyAndQueue } = await import('@factory/core');
  const { setShadowMode } = await import('@factory/core');
  await initDb();
  const { orgId } = await seedDemoData('precision-metalworks');

  // digest_send is seeded as 'auto' — the only auto action in the pack
  const pol = await query<{ decision: string }>(
    "select decision from policies where org_id=$1 and action_type='digest_send' limit 1",
    [orgId]
  );
  if (pol[0]?.decision !== 'auto') {
    return { name: _c.name, kind: _c.kind, pass: false, detail: `expected seeded digest_send=auto, got ${pol[0]?.decision}` };
  }

  let executed = 0;
  const executor = async () => {
    executed += 1;
    return { ok: true };
  };

  // shadow mode ON (pilot default): auto must become ask — nothing executes
  await setShadowMode(orgId, true);
  const shadowed = await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'digest_send',
      entityType: 'digest',
      payload: { demo: true },
      preview: 'Daily digest — eval',
      risk: 'external',
    },
    executor
  );
  const pending = await query<{ c: string }>(
    "select count(*) as c from approvals where org_id=$1 and status='pending' and action_type='digest_send'",
    [orgId]
  );
  const issues: string[] = [];
  if (shadowed.decision !== 'ask') issues.push(`expected ask in shadow mode, got ${shadowed.decision}`);
  if (!shadowed.approvalId) issues.push('expected an approvalId in shadow mode');
  if (executed !== 0) issues.push(`executor ran ${executed} times in shadow mode`);
  if (Number(pending[0]?.c ?? 0) !== 1) issues.push(`expected 1 pending approval, got ${pending[0]?.c}`);

  // shadow mode OFF: the same action executes immediately per its auto policy
  await setShadowMode(orgId, false);
  const live = await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'digest_send',
      entityType: 'digest',
      payload: { demo: 2 },
      preview: 'Daily digest — eval (live)',
      risk: 'external',
    },
    executor
  );
  if (live.decision !== 'auto') issues.push(`expected auto when live, got ${live.decision}`);
  if (executed !== 1) issues.push(`executor ran ${executed} times when live, expected 1`);

  return { name: _c.name, kind: _c.kind, pass: issues.length === 0, detail: issues.join('; ') || 'ok' };
}

// --- pilot readiness: auto e-invoicing (IRN) -----------------------------------

const GSTIN_RE = '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$';

async function seedInvoiceWithGstin(orgId: string): Promise<{ id: string; code: string }> {
  const { query } = await import('@factory/db');
  // seller GSTIN on org settings (evaluates the same validation as prod)
  await query(`update organizations set settings = coalesce(settings,'{}'::jsonb) || '{"gstin":"29ABCDE9999F1Z5"}'::jsonb where id=$1`, [orgId]);
  let inv = (
    await query<{ id: string; code: string | null }>(
      `select e.id, e.code from entities e join entities p on p.id = e.party_id
       where e.org_id=$1 and e.type='invoice' and e.status in ('dispatched','sent')
         and coalesce(p.data->>'gstin','') ~ $2 limit 1`,
      [orgId, GSTIN_RE]
    )
  )[0];
  if (!inv) {
    inv = (
      await query<{ id: string; code: string | null }>(
        `select id, code from entities where org_id=$1 and type='invoice' order by date desc limit 1`,
        [orgId]
      )
    )[0];
    if (!inv) throw new Error('seed produced no invoices');
    await query(`update entities set status='sent' where org_id=$1 and id=$2`, [orgId, inv.id]);
  }
  return { id: inv.id, code: inv.code ?? inv.id };
}

async function runEinvoice(c: EinvoiceCase): Promise<Result> {
  const { initDb, seedDemoData, query } = await import('@factory/db');
  const { generateEInvoice } = await import('@factory/agents');
  await initDb();
  const { orgId } = await seedDemoData('precision-metalworks');
  const inv = await seedInvoiceWithGstin(orgId);

  const first = await generateEInvoice(orgId, inv.code, 'eval');
  const issues: string[] = [];
  if (!first.ok) issues.push(`first generation failed: ${first.error}`);
  if (!first.irn || first.irn.length !== 64) issues.push(`irn missing/short: ${first.irn?.length ?? 0}`);

  // idempotency: a second call returns the SAME IRN, never a duplicate
  const second = await generateEInvoice(orgId, inv.code, 'eval');
  if (!second.ok) issues.push(`second generation failed: ${second.error}`);
  if (!second.alreadyGenerated) issues.push('expected alreadyGenerated on the second call');
  if (second.irn !== first.irn) issues.push('IRN changed between calls — not idempotent');

  const stored = await query<{ irn: string | null }>(`select data->>'irn' as irn from entities where id=$1`, [inv.id]);
  if (stored[0]?.irn !== first.irn) issues.push('IRN not persisted on the invoice');
  return { name: c.name, kind: c.kind, pass: issues.length === 0, detail: issues.join('; ') || `irn=${first.irn?.slice(0, 12)}…` };
}

// --- pilot readiness: e-way bill validation ------------------------------------

async function runEwb(c: EwbCase): Promise<Result> {
  const { initDb, seedDemoData } = await import('@factory/db');
  const { generateEInvoice } = await import('@factory/agents');
  const { generateEWayBill } = await import('@factory/agents');
  await initDb();
  const { orgId } = await seedDemoData('precision-metalworks');
  const inv = await seedInvoiceWithGstin(orgId);
  const issues: string[] = [];

  // garbage input must be rejected, never guessed
  const bad = await generateEWayBill(orgId, inv.code, { vehicleNumber: '12', fromPincode: '12', toPincode: 'abc' }, 'eval');
  if (bad.generated) issues.push('garbage input generated an EWB');
  if (!bad.error) issues.push('garbage input returned no error message');

  // an EWB needs a registered IRN first (Part-A) — the API enforces the order
  const noIrn = await generateEWayBill(orgId, inv.code, { vehicleNumber: 'KA01AB1234', fromPincode: '560001', toPincode: '411001' }, 'eval');
  if (noIrn.generated) issues.push('EWB generated without an IRN');

  const irn = await generateEInvoice(orgId, inv.code, 'eval');
  if (!irn.ok) issues.push(`IRN generation failed: ${irn.error}`);

  const good = await generateEWayBill(
    orgId,
    inv.code,
    { vehicleNumber: 'KA01AB1234', fromPincode: '560001', toPincode: '411001', transporterName: 'VRL' },
    'eval'
  );
  if (!good.generated) issues.push(`valid EWB failed: ${good.error}`);
  if (!good.ewbNo || !/^\d{12}$/.test(good.ewbNo)) issues.push(`ewbNo malformed: ${good.ewbNo}`);
  if (!good.validUntil) issues.push('validUntil missing');
  return { name: c.name, kind: c.kind, pass: issues.length === 0, detail: issues.join('; ') || `ewb=${good.ewbNo}` };
}

// --- pilot readiness: override-rate exit metric --------------------------------

function mondayUTC(ts: number): number {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86_400_000;
}

async function runOverrideRate(c: OverrideRateCase): Promise<Result> {
  const { initDb, seedDemoData, query } = await import('@factory/db');
  const { overrideRateReport } = await import('@factory/agents');
  await initDb();
  // a dedicated org: evals share the in-memory DB, and the einvoicing/ewb
  // cases log executed agent_actions on precision-metalworks — this case
  // needs clean week buckets for exact arithmetic assertions
  const { orgId } = await seedDemoData('sunfresh-foods');

  const now = Date.now();
  const day = 86_400_000;
  const t2 = new Date(now - 2 * day).toISOString(); // current week
  const t9 = new Date(now - 9 * day).toISOString(); // previous week
  await query(
    `insert into agent_actions (org_id, actor, action_type, summary, status, executed_at, created_at)
     values ($1,'agent','send_reminder','Eval fixture A','executed',$2::timestamptz,$2::timestamptz), ($1,'agent','send_reminder','Eval fixture B','executed',$2::timestamptz,$2::timestamptz),
             ($1,'agent','send_reminder','Eval fixture C','undone',$2::timestamptz,$2::timestamptz)`,
    [orgId, t2]
  );
  await query(
    `update agent_actions set undone_at=$2::timestamptz where org_id=$1 and summary='Eval fixture C'`,
    [orgId, new Date(now).toISOString()]
  );
  await query(
    `insert into agent_actions (org_id, actor, action_type, summary, status, executed_at, created_at)
     values ($1,'agent','send_reminder','Eval fixture D','executed',$2::timestamptz,$2::timestamptz)`,
    [orgId, t9]
  );

  const report = await overrideRateReport(orgId, 6);

  // expected bucketing, replicated in JS: each ISO week bucket (Monday-anchored)
  const buckets = new Map<number, { executed: number; overridden: number }>();
  const add = (ts: number, executed: number, overridden: number) => {
    const k = mondayUTC(ts);
    const b = buckets.get(k) ?? { executed: 0, overridden: 0 };
    b.executed += executed;
    b.overridden += overridden;
    buckets.set(k, b);
  };
  add(new Date(t2).getTime(), 2, 1); // 2 executed + 1 undone this week
  add(new Date(t9).getTime(), 1, 0); // 1 executed last week

  const issues: string[] = [];
  for (const [monday, b] of buckets) {
    const label = new Date(monday).toISOString().slice(0, 10);
    const row = report.weeks.find((w) => w.weekStart === label);
    if (!row) {
      issues.push(`report missing week ${label}`);
      continue;
    }
    const pct = b.executed + b.overridden === 0 ? 0 : Math.round((b.overridden / (b.executed + b.overridden)) * 1000) / 10;
    if (row.executed !== b.executed) issues.push(`week ${label}: executed ${row.executed} != ${b.executed}`);
    if (row.undos !== b.overridden) issues.push(`week ${label}: undone ${row.undos} != ${b.overridden}`);
    if (row.overrideRatePct !== pct) issues.push(`week ${label}: pct ${row.overrideRatePct} != ${pct}`);
  }
  // the current-week bucket should be the crafted 33.3% and trend worsening
  const thisWeekPct = report.lastWeek?.overrideRatePct;
  if (thisWeekPct !== undefined && thisWeekPct !== 0 && thisWeekPct !== c.expectLastWeekPct) {
    issues.push(`current-week pct ${thisWeekPct} != expected ${c.expectLastWeekPct}`);
  }
  if (report.trend !== 'worsening') issues.push(`trend ${report.trend} != worsening`);
  return {
    name: c.name,
    kind: c.kind,
    pass: issues.length === 0,
    detail: issues.join('; ') || `lastWeek=${report.lastWeek?.overrideRatePct}% trend=${report.trend}`,
  };
}

// --- pilot readiness: scrap weighbridge flow (F8) ------------------------------

async function runWeighbridge(c: WeighbridgeCase): Promise<Result> {
  const { initDb, seedDemoData, query, insertEntity } = await import('@factory/db');
  const { extractWeighbridgeFromText, processWeighbridgeTicket } = await import('@factory/agents');
  const { decideApproval } = await import('@factory/core');
  await initDb();
  const { orgId } = await seedDemoData('greencycle-recyclers'); // scrap vertical
  const issues: string[] = [];

  // 1. deterministic text extraction
  const t = extractWeighbridgeFromText('gross 5420 tare 1220 grade MS solid from Ramesh ticket WB-7723');
  if (t.netKg !== 4200) issues.push(`net ${t.netKg} != 4200 (gross-tare)`);
  if (t.sellerName !== 'Ramesh') issues.push(`seller ${t.sellerName} != Ramesh`);
  if (t.ticketNo !== 'WB-7723') issues.push(`ticketNo ${t.ticketNo} != WB-7723`);

  // 2. rate card: a scrap item carrying data.grade + stdRate
  const card = await insertEntity({
    orgId, type: 'item', name: 'MS Solid Scrap', status: 'active', source: 'seed',
    data: { grade: 'MS-solid', uom: 'kg', stdRate: 18 },
  });
  const gradeRate = await query<{ rate: string | null }>(
    `select data->>'stdRate' as rate from entities where id = $1`,
    [card.id]
  );
  if (gradeRate[0]?.rate !== '18') issues.push('rate card stdRate not stored');

  // 3. intake drafts through the policy engine (shadow mode ON = ask)
  const { setShadowMode } = await import('@factory/core');
  await setShadowMode(orgId, true);
  const intake = await processWeighbridgeTicket(orgId, t, { via: 'whatsapp-text', from: '919812345678' });
  if (intake.ticket.netKg !== 4200) issues.push(`ticket net ${intake.ticket.netKg} != 4200`);
  if (!intake.reply.replace(/,/g, '').includes('4200')) issues.push(`reply missing net weight: ${intake.reply.slice(0, 80)}`);
  if (intake.decision !== 'ask') {
    issues.push(`expected decision ask in shadow mode, got ${intake.decision}`);
  } else if (!intake.approvalId) {
    issues.push('shadow draft produced no approvalId');
  }

  // 4. owner approves → entry + inward stock movement recorded
  let approved = false;
  if (intake.approvalId) {
    const res = await decideApproval(intake.approvalId, 'approve', 'eval-owner', (pl) =>
      import('@factory/agents').then(({ executeAction }) => executeAction(orgId, 'weighbridge_entry', pl as Record<string, unknown>))
    );
    approved = (res as { status?: string }).status === 'executed';
    if (!approved) issues.push(`approval did not execute: ${JSON.stringify(res).slice(0, 120)}`);
  }
  const entry = await query<{ id: string; qty: string; data: Record<string, unknown> }>(
    `select id, qty, data from entities where org_id=$1 and type='purchase_entry' and data->>'ticketNo'='WB-7723' order by created_at desc limit 1`,
    [orgId]
  );
  if (!entry[0]) {
    issues.push('purchase entry not recorded after approval');
  } else if (Number(entry[0].qty) !== 4200) {
    issues.push(`entry qty ${entry[0].qty} != 4200`);
  }
  const ledger = await query<{ c: string }>(
    `select count(*) as c from entities where org_id=$1 and type='stock_ledger' and data->>'kind'='inward_scrap' and data->>'grade' ilike '%MS%'`,
    [orgId]
  );
  if (approved && Number(ledger[0]?.c ?? 0) < 1) issues.push('inward scrap stock movement missing');

  return {
    name: c.name,
    kind: c.kind,
    pass: issues.length === 0,
    detail: issues.join('; ') || `4200kg drafted→approved→ledger (+${ledger[0]?.c ?? 0} inward)`,
  };
}

// --- pilot readiness: closed-loop remediation ----------------------------------

async function runRemediation(c: RemediationCase): Promise<Result> {
  const { initDb, seedDemoData, query } = await import('@factory/db');
  const { scanAnomalies, proposeTopRemediation, proposeRemediation, executeAction } = await import('@factory/agents');
  const { decideApproval } = await import('@factory/core');
  await initDb();
  // dedicated org: anomaly medians on precision-metalworks shift with the
  // einvoicing/ewb cases; texstyle gives deterministic fixtures
  const { orgId } = await seedDemoData('texstyle-exports');
  const issues: string[] = [];

  // fixture: two identical invoices for the same customer 1 day apart
  const party = (
    await query<{ id: string; name: string | null }>(
      `select id, coalesce(name, data->>'name') as name from entities
       where org_id=$1 and type='party' and coalesce(data->>'kind','customer')='customer' limit 1`,
      [orgId]
    )
  )[0];
  if (!party) throw new Error('no customer party in seed');
  await query(
    `insert into entities (id, org_id, type, code, status, party_id, amount, qty, rate, date, source, data)
     values (gen_random_uuid()::text, $1,'invoice','EVAL-DUP-1','sent',$2,50000,10,5000,current_date - 2,'seed','{}'::jsonb),
            (gen_random_uuid()::text, $1,'invoice','EVAL-DUP-2','sent',$2,50000,10,5000,current_date - 1,'seed','{}'::jsonb)`,
    [orgId, party.id]
  );

  // 1. the duplicate fires as a HIGH anomaly
  const report = await scanAnomalies(orgId);
  const dupe = report.anomalies.find((a) => a.kind === 'duplicate_invoice' && a.title.includes('EVAL-DUP-1'));
  if (!dupe) issues.push(`duplicate anomaly not detected (got ${report.anomalies.map((a) => a.kind).join(',')})`);
  else if (dupe.severity !== 'high') issues.push(`duplicate severity ${dupe.severity} != high`);

  // 2. the duplicate maps to the right fix — a credit-note draft, not a reminder
  const dupeProposal = dupe ? await proposeRemediation(orgId, dupe) : null;
  if (!dupeProposal || dupeProposal.actionType !== 'credit_note_draft') {
    issues.push(`duplicate remediation ${dupeProposal?.actionType ?? 'null'} != credit_note_draft`);
  }

  // 3. the pipeline end to end: the engine's worst finding becomes a concrete
  // draft through the policy engine (which anomaly wins depends on the seed's
  // receivables history — the pipeline shape is what's under test here)
  const outcome = await proposeTopRemediation(orgId);
  if (outcome.decision === 'skipped') {
    issues.push(`remediation skipped: ${outcome.reason}`);
  } else if (outcome.decision !== 'ask') {
    issues.push(`expected ask (shadow on), got ${outcome.decision}`);
  } else if (!outcome.approvalId || !outcome.proposal) {
    issues.push('proposal queued without approvalId/proposal');
  }

  // 4. owner approves → the drafted action executes for real
  let executed = false;
  if (outcome.approvalId && outcome.proposal) {
    const res = await decideApproval(outcome.approvalId, 'approve', 'eval-owner', (pl) =>
      executeAction(orgId, outcome.proposal!.actionType, pl as Record<string, unknown>)
    );
    executed = (res as { status?: string }).status === 'executed';
    if (!executed) issues.push(`approval did not execute: ${JSON.stringify(res).slice(0, 120)}`);
  }
  if (executed && outcome.proposal?.actionType === 'credit_note_draft') {
    const cn = await query<{ c: string }>(
      `select count(*) as c from entities where org_id=$1 and type='credit_note' and data->>'againstInvoice'='EVAL-DUP-1'`,
      [orgId]
    );
    if (Number(cn[0]?.c ?? 0) < 1) issues.push('credit note entity missing after execution');
  }

  // 5. the loop closes in the audit trail
  const audited = await query<{ c: string }>(
    `select count(*) as c from audit_log where org_id=$1 and action='remediation.proposed'`,
    [orgId]
  );
  if (Number(audited[0]?.c ?? 0) < 1) issues.push('remediation.proposed audit entry missing');

  return {
    name: c.name,
    kind: c.kind,
    pass: issues.length === 0,
    detail:
      issues.join('; ') ||
      `dupes→credit_note_draft ✓ · pipeline ${outcome.proposal?.actionType}→${outcome.decision}${executed ? '→executed' : ''}`,
  };
}

// --- agent workflows: A5 quote comparison --------------------------------------

async function runQuoteComparison(c: QuoteComparisonCase): Promise<Result> {
  const { initDb, seedDemoData, query } = await import('@factory/db');
  const { compareVendorQuotes, parseQuoteReply } = await import('@factory/agents');
  await initDb();
  const { orgId } = await seedDemoData('precision-metalworks');
  const issues: string[] = [];

  // 1. regex extraction from a verbatim vendor reply
  const parsed = parseQuoteReply('Rate ₹234/kg, delivery in 6 days after PO. Minimum 500kg please.');
  if (parsed.rate !== 234) issues.push(`parsed rate ${parsed.rate} != 234`);
  if (parsed.leadTimeDays !== 6) issues.push(`parsed lead ${parsed.leadTimeDays} != 6`);

  // 2. comparison: A cheapest and meets date; B meets but dearer; C misses the date
  const needBy = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const vendor = (
    await query<{ id: string; name: string | null }>(
      `select id, coalesce(name, data->>'name') as name from entities
       where org_id=$1 and type='party' and data->>'kind'='vendor' order by name limit 1`,
      [orgId]
    )
  )[0];
  if (!vendor) throw new Error('no vendor in seed');
  // the RFQ must exist for quotes to attach to
  await query(
    `insert into entities (id, org_id, type, code, status, source, data)
     values (gen_random_uuid()::text, $1, 'rfq', 'EVAL-RFQ-1', 'sent', 'seed', '{}'::jsonb)`,
    [orgId]
  );
  const cmp = await compareVendorQuotes(
    orgId,
    'EVAL-RFQ-1',
    [
      { vendorName: vendor.name ?? 'V1', replyText: '₹234/kg, delivery in 6 days' },
      { vendorName: vendor.name ?? 'V1', rate: 260, leadTimeDays: 5 },
      { vendorName: vendor.name ?? 'V1', rate: 200, leadTimeDays: 30 },
    ],
    needBy
  );
  if (!cmp.recommended || cmp.recommended.rate !== 234) {
    issues.push(`recommendation ${JSON.stringify(cmp.recommended)} != rate 234 pick`);
  }
  if (cmp.quotes[2]?.meetsRequirement !== false) issues.push('late quote wrongly marked as meeting requirement');
  if (!cmp.recommended?.why.includes('under the next best')) issues.push(`expected next-best delta in the why: ${cmp.recommended?.why}`);

  // 3. persisted against the party for the purchase head's thread
  const stored = await query<{ c: string }>(
    `select count(*) as c from entities where org_id=$1 and type='vendor_quote' and data->>'rfqCode'='EVAL-RFQ-1'`,
    [orgId]
  );
  if (Number(stored[0]?.c ?? 0) < 3) issues.push(`vendor_quote rows ${stored[0]?.c} != 3`);
  return {
    name: c.name,
    kind: c.kind,
    pass: issues.length === 0,
    detail: issues.join('; ') || `pick ${cmp.recommended?.vendorName} @ ₹${cmp.recommended?.rate} · ${stored[0]?.c} quotes stored`,
  };
}

// --- agent workflows: A4 collections discipline ----------------------------------

async function runCollections(c: CollectionsCase): Promise<Result> {
  const { initDb, seedDemoData, query } = await import('@factory/db');
  const { getReminderCandidates, batchDraftReminders, detectPromiseToPay, recordPromiseToPay } = await import('@factory/agents');
  const { setShadowMode } = await import('@factory/core');
  await initDb();
  const { orgId } = await seedDemoData('sunfresh-foods');
  const issues: string[] = [];
  await setShadowMode(orgId, true);

  // pick an overdue invoice from the seed
  const inv = (
    await query<{ id: string; code: string | null }>(
      `select id, code from entities where org_id=$1 and type='invoice' and status in ('sent','overdue','partial')
         and (data->>'dueDate')::date < current_date limit 1`,
      [orgId]
    )
  )[0];
  if (!inv) throw new Error('no overdue invoice in seed');

  // 1. eligible the first time
  const first = await getReminderCandidates(orgId);
  if (!first.eligible.some((e) => e.invoiceId === inv.id)) issues.push('overdue invoice not eligible on first pass');

  // 2. cooldown: pretend a reminder was sent yesterday
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await query(`update entities set data = data || jsonb_build_object('lastReminderAt', $2::text) where id=$1`, [inv.id, yesterday]);
  const second = await getReminderCandidates(orgId);
  if (!second.skipped.some((e) => e.invoiceId === inv.id && e.skippedReason === 'cooldown')) {
    issues.push('cooldown not honoured after a reminder yesterday');
  }

  // 3. promise-to-pay beats the cooldown once recorded
  const ptpDate = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const rec = await recordPromiseToPay(orgId, { invoiceId: inv.id, promiseDate: ptpDate, note: 'eval', via: 'eval' });
  if (!rec.ok) issues.push(`promise not recorded: ${rec.error}`);
  const third = await getReminderCandidates(orgId);
  const entry = third.skipped.find((e) => e.invoiceId === inv.id);
  if (!entry || entry.skippedReason !== 'promise') issues.push(`promise not honoured: ${entry?.skippedReason ?? 'still eligible'}`);

  // 4. batch draft routes through the policy engine (shadow → ask)
  const batch = await batchDraftReminders(orgId);
  if (batch.decision !== 'ask') issues.push(`batch decision ${batch.decision} != ask in shadow mode`);
  if (!batch.approvalId) issues.push('batch produced no approvalId');
  if (batch.messages.length && !batch.messages[0]!.text.includes('₹')) issues.push('reminder template missing amount');

  // 5. promise-date detection from a customer's reply text
  const d = detectPromiseToPay('we will pay by 15/01, promise');
  if (!d || d.date !== `${new Date().getFullYear()}-01-15`) issues.push(`dmy detection failed: ${JSON.stringify(d)}`);
  return {
    name: c.name,
    kind: c.kind,
    pass: issues.length === 0,
    detail: issues.join('; ') || `cooldown+promise honoured · batch ${batch.count} msgs (${batch.decision}) · date parse ok`,
  };
}

// --- agent workflows: A8 shift report ---------------------------------------------

async function runShiftReport(c: ShiftReportCase): Promise<Result> {
  const { initDb, seedDemoData, query } = await import('@factory/db');
  const { extractShiftReport, sanityCheck, processShiftNote } = await import('@factory/agents');
  const { setShadowMode } = await import('@factory/core');
  await initDb();
  const { orgId } = await seedDemoData('precision-metalworks');
  const issues: string[] = [];
  await setShadowMode(orgId, true);

  // 1. deterministic extraction from a Hinglish transcript
  const jc = (
    await query<{ code: string | null; qty: string | null }>(
      `select code, qty from entities where org_id=$1 and type='job_card' order by date desc limit 1`,
      [orgId]
    )
  )[0];
  if (!jc?.code) throw new Error('no job card in seed');
  const r = extractShiftReport(`output 250 pieces, 8 reject, downtime 45 minutes due to tool change on ${jc.code}`);
  if (r.outputQty !== 250) issues.push(`output ${r.outputQty} != 250`);
  if (r.rejectQty !== 8) issues.push(`rejects ${r.rejectQty} != 8`);
  if (r.downtimeMins !== 45) issues.push(`downtime ${r.downtimeMins} != 45`);
  if (r.jobCardCode?.toUpperCase() !== jc.code.toUpperCase()) issues.push(`job card ${r.jobCardCode} != ${jc.code}`);

  // 2. missing output → ONE clarifying question, never a guess
  const clarify = await processShiftNote(orgId, 'two rejects on the second machine today');
  if (!clarify.needsClarification) issues.push('expected a clarification ask when output is missing');
  if (!clarify.reply.toLowerCase().includes('how many')) issues.push(`clarification unclear: ${clarify.reply}`);

  // 3. full report → policy-gated job-card write (shadow → ask)
  const full = await processShiftNote(orgId, `output 120, reject 3, downtime 20 minutes due to material shortage, job card ${jc.code}`);
  if (full.needsClarification) issues.push(`unexpected clarification: ${full.clarification}`);
  if (full.decision !== 'ask') issues.push(`expected ask in shadow mode, got ${full.decision}`);
  if (!full.approvalId) issues.push('no approvalId for the shift write');

  // 4. sanity flags absurd numbers
  const flags = sanityCheck({ ...r, outputQty: (jc.qty ? Number(jc.qty) : 100) * 5 }, { qty: jc.qty });
  if (!flags.some((f) => f.includes('2×'))) issues.push(`absurd output not flagged: ${flags.join('; ')}`);
  return {
    name: c.name,
    kind: c.kind,
    pass: issues.length === 0,
    detail: issues.join('; ') || `extract ok · clarify ok · ${full.decision}${full.approvalId ? '+approval' : ''} · flags ok`,
  };
}

// --- agent workflows: A10 compliance threshold -------------------------------------

async function runComplianceThreshold(c: ComplianceThresholdCase): Promise<Result> {
  const { checkEinvoiceApplicability, EINVOICE_THRESHOLD_INR } = await import('@factory/agents');
  const issues: string[] = [];

  // rule is config, and behaves: B2B + amount, B2C, and below-threshold cases
  if (EINVOICE_THRESHOLD_INR <= 0) issues.push('threshold must be positive');
  const ok = checkEinvoiceApplicability({ amount: EINVOICE_THRESHOLD_INR, buyerGstin: '29ABCDE1234F1Z5' });
  if (!ok.applicable) issues.push(`B2B at threshold not applicable: ${ok.reason}`);
  const b2c = checkEinvoiceApplicability({ amount: 500_000, buyerGstin: null });
  if (b2c.applicable) issues.push('B2C wrongly applicable');
  const bad = checkEinvoiceApplicability({ amount: 500_000, buyerGstin: 'HELLO' });
  if (bad.applicable) issues.push('invalid GSTIN wrongly applicable');
  const low = checkEinvoiceApplicability({ amount: EINVOICE_THRESHOLD_INR - 1, buyerGstin: '29ABCDE1234F1Z5' });
  if (low.applicable) issues.push('below-threshold wrongly applicable');
  return {
    name: c.name,
    kind: c.kind,
    pass: issues.length === 0,
    detail: issues.join('; ') || `threshold ₹${EINVOICE_THRESHOLD_INR}: B2B ✓ B2C ✗ invalid ✗ below ✗`,
  };
}

// --- agent workflows: A13 maintenance PM -------------------------------------------

async function runMaintenance(c: MaintenanceCase): Promise<Result> {
  const { initDb, seedDemoData, query } = await import('@factory/db');
  const { checkDueMaintenance, draftMaintenanceWorkOrders } = await import('@factory/agents');
  const { setShadowMode } = await import('@factory/core');
  await initDb();
  const { orgId } = await seedDemoData('precision-metalworks');
  const issues: string[] = [];
  await setShadowMode(orgId, true);

  // fixture: one machine overdue (45d ago + 30d interval), one recently
  // serviced, and one stripped of its interval (must be listed, not guessed)
  await query(
    `update entities set data = data || jsonb_build_object('lastPmDate', to_char(current_date - 45, 'YYYY-MM-DD'), 'pmIntervalDays', 30)
     where org_id=$1 and type='machine' and code='CNC-1'`,
    [orgId]
  );
  await query(
    `update entities set data = data - 'pmIntervalDays' where org_id=$1 and type='machine' and code='Press-1'`,
    [orgId]
  );
  await query(
    `update entities set data = data || jsonb_build_object('lastPmDate', to_char(current_date - 5, 'YYYY-MM-DD'), 'pmIntervalDays', 30)
     where org_id=$1 and type='machine' and code='CNC-2'`,
    [orgId]
  );

  const { due, missingInterval } = await checkDueMaintenance(orgId, 14);
  const cnc1 = due.find((d) => d.code === 'CNC-1');
  if (!cnc1) issues.push(`CNC-1 not flagged due (got: ${due.map((d) => d.code).join(',')})`);
  else if (cnc1.daysOverdue !== 15) issues.push(`CNC-1 daysOverdue ${cnc1.daysOverdue} != 15`);
  if (due.some((d) => d.code === 'CNC-2')) issues.push('CNC-2 wrongly flagged (serviced 5 days ago)');
  if (!missingInterval.length) issues.push('expected machines without intervals to be listed, not guessed');

  // draft WOs through policy: overdue machine → ask in shadow mode
  const drafts = await draftMaintenanceWorkOrders(orgId);
  const cnc1Draft = drafts.drafts.find((d) => d.machine === cnc1?.machine);
  if (!cnc1Draft) issues.push('no WO drafted for CNC-1');
  else if (cnc1Draft.decision !== 'ask') issues.push(`WO decision ${cnc1Draft.decision} != ask in shadow`);
  return {
    name: c.name,
    kind: c.kind,
    pass: issues.length === 0,
    detail: issues.join('; ') || `CNC-1 ${cnc1?.daysOverdue}d overdue → WO ${cnc1Draft?.decision ?? '-'} · ${missingInterval.length} machines need intervals`,
  };
}

async function main() {
  console.log('Factory AI OS — eval suite');
  const results: Result[] = [];
  for (const c of GOLDEN_CASES) {
    try {
      if (c.kind === 'extraction') results.push(await runExtraction(c));
      else if (c.kind === 'metric') results.push(await runMetricCase(c));
      else if (c.kind === 'guardrail') results.push(await runGuardrail(c));
      else if (c.kind === 'shadow_mode') results.push(await runShadowMode(c));
      else if (c.kind === 'einvoicing') results.push(await runEinvoice(c));
      else if (c.kind === 'ewb_validation') results.push(await runEwb(c));
      else if (c.kind === 'override_rate') results.push(await runOverrideRate(c));
      else if (c.kind === 'weighbridge_flow') results.push(await runWeighbridge(c));
      else if (c.kind === 'remediation_pipeline') results.push(await runRemediation(c));
      else if (c.kind === 'quote_comparison') results.push(await runQuoteComparison(c));
      else if (c.kind === 'collections_flow') results.push(await runCollections(c));
      else if (c.kind === 'shift_report') results.push(await runShiftReport(c));
      else if (c.kind === 'compliance_threshold') results.push(await runComplianceThreshold(c));
      else if (c.kind === 'maintenance_schedule') results.push(await runMaintenance(c));
    } catch (e) {
      results.push({ name: c.name, kind: c.kind, pass: false, detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  [${r.kind}] ${r.name} — ${r.detail}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
