import { GOLDEN_CASES, type ExtractionCase, type MetricCase, type GuardrailCase } from './cases.js';

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

async function main() {
  console.log('Factory AI OS — eval suite');
  const results: Result[] = [];
  for (const c of GOLDEN_CASES) {
    try {
      if (c.kind === 'extraction') results.push(await runExtraction(c));
      else if (c.kind === 'metric') results.push(await runMetricCase(c));
      else if (c.kind === 'guardrail') results.push(await runGuardrail(c));
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
