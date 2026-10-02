import './env.js';

/**
 * Forecast-accuracy surface verification (A11 trust metric):
 *   cd packages/evals && npm run verify:forecast-accuracy
 * Seeds, backdates two snapshots whose horizon has elapsed (one close
 * projection, one bad one), then asserts scoring + the owner-facing summary
 * + the digest/pilot-digest sections render the same numbers.
 */
import { query, seedDemoData } from '@factory/db';
import {
  forecastAccuracySummary,
  forecastAccuracyTrend,
  suggestReorderAdjustments,
  recordTrendSnapshot,
  trendTrajectory,
  trendTrajectoryText,
  generateDigest,
  generatePilotDigest,
  pilotDigestText,
} from '@factory/agents';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const { orgId } = await seedDemoData('precision-metalworks');

// Pick two REAL seeded items and read their actual sales over the exact
// window a backdated snapshot would be scored on (week_start = today-35,
// 4-week horizon → [today-35, today-7)).
const realItems = await query<{ item_id: string; name: string | null; units: string }>(
  `select so.item_id, max(i.name) as name, sum(so.qty)::text as units
   from entities so join entities i on i.id = so.item_id
   where so.org_id = $1 and so.type = 'sales_order' and so.status != 'cancelled'
     and so.date >= current_date - 35 and so.date < current_date - 7
   group by so.item_id order by sum(so.qty) desc limit 2`,
  [orgId]
);
if (realItems.length < 2) {
  console.log('FAIL  seed has <2 items with sales in the scored window');
  process.exit(1);
}

// snapshot projections: 0.8× and 3× the real actuals → accuracies 80% and ~33%
for (const [i, it] of realItems.entries()) {
  const mult = i === 0 ? 0.8 : 3;
  await query(
    `insert into forecast_snapshots (org_id, item_id, item_name, week_start, horizon_weeks, forecast_weekly, projected_units)
     select $1, $2, $3, current_date - 35, 4, 10, round($5::numeric * $4) from (select $1::uuid as oid) s
     where not exists (select 1 from forecast_snapshots where org_id = $1 and item_id = $2 and week_start = current_date - 35)`,
    [orgId, it.item_id, it.name, mult, Number(it.units)]
  );
}

const summary = await forecastAccuracySummary(orgId, 5);
check('snapshots scored (item-scoped)', summary.scored >= 2, `scored=${summary.scored} avg=${summary.averagePct}`);
const rowFor = (id: string) => summary.worst.find((w) => w.item === (realItems.find((r) => r.item_id === id)?.name ?? ''));
const first = realItems[0]!;
const second = realItems[1]!;
const fRow = rowFor(first.item_id);
const sRow = rowFor(second.item_id);
check('actuals are item-scoped (not org-wide)', !!fRow && Math.abs(fRow.actualUnits - Number(first.units)) < 1e-9, `expected ${first.units}, got ${fRow?.actualUnits}`);
check('accuracy math per item', !!fRow && Math.abs(fRow.accuracyPct - (1 - Math.abs(Math.round(0.8 * Number(first.units)) - Number(first.units)) / Number(first.units)) * 100) < 0.15, `${fRow?.accuracyPct}% (rounded projection → ~80.2)`);
check('bad projection scores low', !!sRow && sRow.accuracyPct < 40, `${sRow?.accuracyPct}%`);
check('verdict present', summary.verdict.length > 10, summary.verdict);
check('worst-first ordering', summary.worst.length >= 2 && summary.worst[0]!.accuracyPct <= summary.worst[summary.worst.length - 1]!.accuracyPct, JSON.stringify(summary.worst.map((w) => w.accuracyPct)));

// trend series: 2 scored rows, same week → one point with the average
const trend = await forecastAccuracyTrend(orgId);
check('trend series has the scored week', trend.length === 1 && trend[0]!.scored === 2 && Math.abs(trend[0]!.averagePct - (summary.averagePct ?? -1)) < 0.01, JSON.stringify(trend));

// self-correcting loop: the 33%-accurate item must get a widened safety
// buffer, and its suggestion 'why' must say so (matched by itemId — seeded
// item names can repeat)
const report = await suggestReorderAdjustments(orgId);
const firstId = realItems[0]!.item_id;
const accItem = report.suggestions.find((s) => s.itemId === firstId);
check(
  'accuracy widens reorder safety (self-correcting)',
  !!accItem && accItem.why.includes('safety widened'),
  accItem ? accItem.why : `no suggestion for item ${firstId} (suggestions: ${report.suggestions.length})`
);

// daily digest carries the section
const digest = await generateDigest(orgId);
const sec = digest.sections.find((s) => s.key === 'forecast_accuracy');
check('daily digest section present', !!sec, sec ? sec.lines.join(' | ') : 'missing');
check('daily digest line shows avg', !!sec && sec.lines[0]!.includes('Average accuracy'), sec?.lines[0] ?? '');

// pilot digest carries block + text line
const pilot = await generatePilotDigest(orgId);
check('pilot digest block present', pilot.forecastAccuracy.scored >= 2, `scored=${pilot.forecastAccuracy.scored}`);
const text = pilotDigestText(pilot);
check('pilot WhatsApp text shows accuracy', text.includes('*Forecast:*'), text.split('\n').find((l) => l.includes('*Forecast:*')) ?? 'missing');
check(
  'pilot WhatsApp text lists misses',
  text.includes('*Biggest forecast misses:*') && (realItems[0]!.name ? text.includes(realItems[0]!.name!) : true),
  text.split('\n').find((l) => l.startsWith('• ')) ?? 'missing'
);

// trajectory snapshots: record → read → text (idempotent per org+day)
await recordTrendSnapshot(orgId);
const traj = await trendTrajectory(orgId);
check('trend snapshot recorded', traj.length >= 1, JSON.stringify(traj));
await recordTrendSnapshot(orgId); // same-day re-run must not duplicate
const traj2 = await trendTrajectory(orgId);
check('trend snapshot idempotent per day', traj2.length === traj.length, `rows=${traj2.length}`);
check('trajectory text empty for a single day', trendTrajectoryText(traj2) === '', trendTrajectoryText(traj2));

console.log(`\n${failures ? `FORECAST-ACCURACY VERIFY FAILED: ${failures} check(s)` : 'Forecast-accuracy surfaces verified.'}`);
process.exit(failures ? 1 : 0);
