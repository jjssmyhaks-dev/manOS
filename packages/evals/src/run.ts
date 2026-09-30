import {
  GOLDEN_CASES,
  type ExtractionCase,
  type MetricCase,
  type GuardrailCase,
  type ShadowModeCase,
  type EinvoiceCase,
  type EwbCase,
  type OverrideRateCase,
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
