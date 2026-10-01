import { GOLDEN_QUESTIONS, type GoldenQuestion } from './golden-questions.js';
import './env.js';

/**
 * Agent 1 golden-question gate (spec done-when): routes every question
 * through the SAME intent classifier the mock model uses in production
 * (packages/agents/mock-model.ts classify()), i.e. the real routing path,
 * offline and deterministic. A question passes when the expected tool is
 * chosen. Tool-execution correctness is covered by the rest of the suite;
 * this gate pins INTENT ROUTING per vertical, which is where a prompt or
 * classifier change would silently regress coverage.
 */

interface RouteResult {
  vertical: string;
  q: string;
  expected: string;
  got: string | null;
  pass: boolean;
}

async function main() {
  console.log('Agent 1 — golden-question routing gate (30 per vertical)');
  const { classifyIntent } = await import('@factory/agents');

  const results: RouteResult[] = [];
  for (const [vertical, questions] of Object.entries(GOLDEN_QUESTIONS)) {
    for (const c of questions as GoldenQuestion[]) {
      let got: string | null = null;
      try {
        got = classifyIntent(c.q, '')?.toolName ?? null;
      } catch {
        got = null;
      }
      results.push({ vertical, q: c.q, expected: c.tool, got, pass: got === c.tool });
    }
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of failed) {
    console.log(`FAIL  [${r.vertical}] "${r.q}" — expected ${r.expected}, routed to ${r.got ?? 'nothing'}`);
  }

  const byVertical: Record<string, { total: number; pass: number }> = {};
  for (const r of results) {
    byVertical[r.vertical] ??= { total: 0, pass: 0 };
    byVertical[r.vertical]!.total++;
    if (r.pass) byVertical[r.vertical]!.pass++;
  }
  for (const [v, s] of Object.entries(byVertical)) {
    console.log(`${v}: ${s.pass}/${s.total} routed correctly`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} golden questions passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
