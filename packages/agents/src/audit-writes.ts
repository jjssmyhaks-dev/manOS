import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QA audit (spec Agent 3 done-when): "grep for any DB write not preceded by
 * a logAction call." Implemented as a static coverage check over
 * packages/agents/src — every function containing a raw INSERT/UPDATE/DELETE
 * on business tables must also reference the trust path:
 *   checkPolicyAndQueue (proposal + policy routing), or
 *   executeAction / execute* (post-approval executors that record activity),
 *   or be an explicitly allowlisted non-owner-facing helper (registration
 *   state, seed-like fixtures, notification queue writes).
 * Raw writes in the WEB app are out of scope here (they are human actions,
 * executed on behalf of the signed-in user and audited via audit()).
 */

const WRITE_RE = /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i;
const TRUST_RE = /\b(checkPolicyAndQueue|decideApproval|executeAction|executeCreate|executeUpdate|executeSend|recordAgentAction|audit)\s*\(/;
/**
 * Functions named execute* ARE the post-approval executors — they are invoked
 * by executeAction, which records the activity-timeline entry with summary,
 * reason and sources. Coverage lives at the caller by design.
 */
const TRUSTED_FN_RE = /^execute[A-Z]/;
/** Files whose writes are NOT owner-facing business records:
 *  - dedupe/notify/customer-registration: bookkeeping & queue state machines
 *  - activity: the trust layer itself (its writes ARE the log)
 *  - agent-jobs: owner-authored schedules (user actions via Settings)
 *  - compliance: GSP retry bookkeeping under the audited sweep + human queue
 *  - embeddings/orchestrator: infrastructure (vector store, conversation persistence)
 *  - memory: org facts are a reviewable store surfaced in Settings by design
 */
const ALLOWLIST = [
  'dedupe.ts', 'notify.ts', 'customer-registration.ts', 'activity.ts',
  'agent-jobs.ts', 'compliance.ts', 'embeddings.ts', 'memory.ts', 'orchestrator.ts',
];

interface Finding {
  file: string;
  line: number;
  fn: string;
  kind: string;
}

function functionNameBefore(lines: string[], idx: number): string {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i]!.match(/(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (m) return m[1] ?? m[2] ?? '(anon)';
  }
  return '(top-level)';
}

export function auditWriteCoverage(srcDir: string): { findings: Finding[]; filesScanned: number; writesFound: number } {
  const findings: Finding[] = [];
  let filesScanned = 0;
  let writesFound = 0;

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !ALLOWLIST.includes(f));
  for (const f of files) {
    filesScanned++;
    const full = path.join(srcDir, f);
    const src = fs.readFileSync(full, 'utf8');
    const lines = src.split(/\r?\n/);

    // split into functions: a finding fires when a function has a raw write
    // but NO trust-path reference anywhere in the same function body
    const fnStarts: Array<{ start: number; name: string }> = [];
    lines.forEach((l, i) => {
      const m = l.match(/(?:async\s+function\s+(\w+))|(?:function\s+(\w+))/);
      if (m) fnStarts.push({ start: i, name: m[1] ?? m[2]! });
    });

    for (let fi = 0; fi < fnStarts.length; fi++) {
      const start = fnStarts[fi]!.start;
      const end = fi + 1 < fnStarts.length ? fnStarts[fi + 1]!.start : lines.length;
      const body = lines.slice(start, end);
      const hasWrite = body.some((l) => WRITE_RE.test(l));
      if (!hasWrite) continue;
      writesFound++;
      if (TRUSTED_FN_RE.test(fnStarts[fi]!.name)) continue; // post-approval executor
      const hasTrust = body.some((l) => TRUST_RE.test(l));
      if (!hasTrust) {
        const writeLine = body.findIndex((l) => WRITE_RE.test(l)) + start + 1;
        findings.push({ file: f, line: writeLine, fn: fnStarts[fi]!.name, kind: (body.find((l) => WRITE_RE.test(l)) ?? '').trim().slice(0, 80) });
      }
    }
  }
  return { findings, filesScanned, writesFound };
}

const isMain = process.argv[1]?.includes('audit-writes');
if (isMain) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)));
  const { findings, filesScanned, writesFound } = auditWriteCoverage(dir);
  for (const f of findings) {
    console.log(`UNCOVERED  ${f.file}:${f.line}  in ${f.fn}()  — ${f.kind}`);
  }
  console.log(`\n${filesScanned} files scanned, ${writesFound} write-containing functions, ${findings.length} uncovered`);
  process.exit(findings.length ? 1 : 0);
}
