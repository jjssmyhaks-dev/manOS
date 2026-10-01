import { GOLDEN_DOCUMENTS } from './golden-documents.js';
import './env.js';

/**
 * A2 per-field accuracy benchmark (spec done-when): scores document
 * extraction field-by-field against the labelled golden set and gates the
 * ≥95% auto-processing threshold. Runs the REAL extraction path
 * (extractDocument → mockExtract in dev) exactly as intake would.
 *
 * Scoring per spec: every expected field is one scored unit; a unit scores 1
 * on an exact match, 0.5 on a partial match (numbers within 1%, or substring
 * party names), 0 otherwise. Documents expected to fail validation are also
 * scored (validation must fire when fields are missing). The gate:
 *   accuracy ≥ 95%  → auto-processing allowed
 *   accuracy < 95%  → CI fails; extraction must not skip the review queue
 */

const AUTO_PROCESS_THRESHOLD = 0.95;

interface DocScore {
  name: string;
  units: number;
  score: number;
  detail: string[];
  pass: boolean;
}

function normName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\b(pvt|ltd|llp|works|industries|traders|enterprises|m\/s|the)\b/g, '').replace(/[^a-z0-9]/g, '');
}

function scoreField(kind: 'exact' | 'name' | 'amount', expected: unknown, got: unknown): number {
  if (expected == null) return got == null ? 1 : 0.5; // absence is also ground truth
  if (got == null) return 0;
  if (kind === 'amount') {
    const e = Number(expected);
    const g = Number(got);
    if (!Number.isFinite(g)) return 0;
    if (g === e) return 1;
    return Math.abs(g - e) / e <= 0.01 ? 0.5 : 0; // within 1% (e.g. tax rounding)
  }
  const e = String(expected).trim();
  const g = String(got).trim();
  if (g === e) return 1;
  if (kind === 'name') {
    const ne = normName(e);
    const ng = normName(g);
    if (ne && ng && (ng.includes(ne) || ne.includes(ng))) return 0.5; // party name with/without suffix
    return 0;
  }
  // exact-kind: tolerate separator variants (PO-7841 vs 7841, JC/2219 vs JC-2219)
  const strip = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return strip(g) === strip(e) ? 1 : 0;
}

async function main() {
  console.log('Agent 2 — golden-document per-field accuracy benchmark');
  const { extractDocument, validateExtraction } = await import('@factory/agents');
  const { initDb } = await import('@factory/db');
  await initDb();

  const results: DocScore[] = [];
  for (const doc of GOLDEN_DOCUMENTS) {
    const detail: string[] = [];
    let units = 0;
    let score = 0;

    const res = await extractDocument('00000000-0000-0000-0000-000000000000', {
      text: doc.text,
      source: 'eval',
      filename: doc.name,
    } as never).catch(() => null);

    const ex = res?.extraction;
    if (!ex) {
      results.push({ name: doc.name, units: 1, score: 0, detail: ['extraction threw'], pass: false });
      continue;
    }

    const e = doc.expected as Record<string, unknown>;
    if ('poNumber' in e) {
      units++;
      const s = scoreField('exact', e.poNumber, ex.poNumber);
      score += s;
      if (s < 1) detail.push(`poNumber ${s < 0.5 ? '≠' : '~'} "${ex.poNumber}" (want "${e.poNumber}")`);
    }
    if ('customerName' in e) {
      units++;
      const s = scoreField('name', e.customerName, ex.customerName);
      score += s;
      if (s < 1) detail.push(`customerName ~ "${ex.customerName}" (want "${e.customerName}")`);
    }
    if ('totalAmount' in e) {
      units++;
      const s = scoreField('amount', e.totalAmount, ex.totalAmount);
      score += s;
      if (s < 1) detail.push(`totalAmount ${ex.totalAmount} (want ${e.totalAmount})`);
    }
    if ('minLines' in e) {
      units++;
      const okLines = ex.lines.length >= (e.minLines as number);
      score += okLines ? 1 : 0;
      if (!okLines) detail.push(`lines ${ex.lines.length} < ${e.minLines}`);
    }

    // bad documents must be flagged for review, never auto-processed
    if (doc.name.includes('garbage') || doc.name.includes('illegible')) {
      units++;
      const flagged = res.needsReview || validateExtraction(ex).length > 0;
      score += flagged ? 1 : 0;
      if (!flagged) detail.push('bad document NOT flagged for review');
    }

    results.push({ name: doc.name, units, score, detail, pass: units === 0 || score / units >= AUTO_PROCESS_THRESHOLD });
  }

  let totalUnits = 0;
  let totalScore = 0;
  for (const r of results) {
    totalUnits += r.units;
    totalScore += r.score;
    const pct = r.units ? Math.round((r.score / r.units) * 100) : 100;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name} — ${pct}% of ${r.units} field${r.units === 1 ? '' : 's'}${r.detail.length ? ` · ${r.detail.join(' · ')}` : ''}`);
  }

  const accuracy = totalUnits ? totalScore / totalUnits : 0;
  console.log(`\nOverall per-field accuracy: ${(accuracy * 100).toFixed(1)}% across ${totalUnits} scored fields`);
  console.log(`Auto-processing gate (≥95%): ${accuracy >= AUTO_PROCESS_THRESHOLD ? 'OPEN — auto-processing justified' : 'CLOSED — keep the review queue'}`);
  const failedDocs = results.filter((r) => !r.pass);
  process.exit(accuracy >= AUTO_PROCESS_THRESHOLD && failedDocs.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
