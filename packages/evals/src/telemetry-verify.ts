import './env.js';

/**
 * P2b telemetry verification (Agent 13 sensor path) — standalone script:
 *   npx tsx src/telemetry-verify.ts  (in packages/evals)
 * Runs the full ingest → detect → alert → EWMA cycle against a throwaway
 * in-memory DB with seeded machines, asserting:
 *   1. reading for an unknown machine (no baseline anywhere) → baselineMissing
 *   2. machine-master adoption: first CNC-2 reading adopts the declared
 *      baseline (2.2) and a healthy reading passes
 *   3. explicit baseline upsert → readable
 *   4. healthy reading nudges the baseline (EWMA α=0.1)
 *   5. anomalous reading fires detectAnomaly, does NOT move the baseline
 *   6. alert lands on the activity timeline + queues a WhatsApp notification
 *   7. recentAnomalies() returns the durable history
 */
import { query, seedDemoData } from '@factory/db';
import { ingestReading, upsertBaseline, getBaseline, detectAnomaly, recentAnomalies } from '@factory/agents';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const { orgId } = await seedDemoData('precision-metalworks');

// 1. unknown machine, no baseline anywhere → baselineMissing
const first = await ingestReading(orgId, { machineCode: 'LOOM-9', metric: 'vibration', value: 2.0 });
check('unknown machine → baselineMissing', first.ok === true && first.baselineMissing === true, JSON.stringify(first));
const stored = await query<{ n: string }>(
  `select count(*)::text as n from machine_telemetry where org_id=$1 and machine_code='LOOM-9' and metric='vibration'`,
  [orgId]
);
check('reading persisted', Number(stored[0]?.n) === 1);

// 2. machine-master adoption: CNC-2 declares baselines.vibration = 2.2;
//    the healthy 2.3 reading then EWMA-nudges it to 2.21 (0.9*2.2 + 0.1*2.3)
const adopted = await ingestReading(orgId, { machineCode: 'CNC-2', metric: 'vibration', value: 2.3 });
const bAdopted = await getBaseline(orgId, 'CNC-2', 'vibration');
check(
  'machine-master baseline adopted',
  adopted.ok === true && !adopted.anomaly && !adopted.baselineMissing && bAdopted !== null && Math.abs(bAdopted.baseline - 2.21) < 1e-9,
  `baseline=${bAdopted?.baseline}`
);

// 3. explicit baseline (what an operator-set threshold looks like)
await upsertBaseline(orgId, 'CNC-1', 'vibration', 2.0, 25);
const b0 = await getBaseline(orgId, 'CNC-1', 'vibration');
check('baseline readable', b0?.baseline === 2.0 && b0?.thresholdPct === 25, JSON.stringify(b0));

// 4. healthy reading → EWMA nudge: 0.9*2.0 + 0.1*2.1 = 2.01
const healthy = await ingestReading(orgId, { machineCode: 'CNC-1', metric: 'vibration', value: 2.1 });
const b1 = await getBaseline(orgId, 'CNC-1', 'vibration');
check('healthy reading: no anomaly', healthy.ok === true && !healthy.anomaly && !healthy.baselineMissing, JSON.stringify(healthy));
check('EWMA nudge applied', b1?.baseline !== undefined && Math.abs(b1.baseline - 2.01) < 1e-9, `baseline=${b1?.baseline}`);

// 5. anomaly: 3.0 vs 2.01 → +49.3%, above the 25% threshold
const bad = await ingestReading(orgId, { machineCode: 'CNC-1', metric: 'vibration', value: 3.0 });
check('anomaly detected', !!bad.anomaly && bad.anomaly.anomalous === true, JSON.stringify(bad));
const b2 = await getBaseline(orgId, 'CNC-1', 'vibration');
check('anomalous reading does not move baseline', b2?.baseline === b1?.baseline, `baseline=${b2?.baseline}`);

// pure function spot-check (spec detectAnomaly signature)
const v = detectAnomaly(3.0, { baseline: 2, thresholdPct: 25 });
check('detectAnomaly math', v.anomalous && v.deviationPct === 50, JSON.stringify(v));

// 6. alert on the activity timeline + WhatsApp queue (CNC-1 only — keep counts exact)
const actions = await query<{ n: string }>(
  `select count(*)::text as n from agent_actions where org_id=$1 and action_type='telemetry_anomaly' and metadata->>'machine'='CNC-1'`,
  [orgId]
);
check('telemetry_anomaly activity recorded', Number(actions[0]?.n) === 1);
const notes = await query<{ n: string }>(
  `select count(*)::text as n from notifications where org_id=$1 and template='telemetry_alert' and status='queued'`,
  [orgId]
);
check('telemetry_alert notification queued', Number(notes[0]?.n) === 1);

// 7. durable history
const hist = await recentAnomalies(orgId, 'CNC-1');
check('recentAnomalies returns history', hist.length === 1 && hist[0]!.machine === 'CNC-1' && hist[0]!.metric === 'vibration', JSON.stringify(hist));

console.log(`\n${failures ? `TELEMETRY VERIFY FAILED: ${failures} check(s)` : 'Telemetry P2b verified end-to-end.'}`);
process.exit(failures ? 1 : 0);
