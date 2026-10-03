import {
  generateDigest,
  scanAnomalies,
  proposeTopRemediation,
  batchDraftReminders,
  runComplianceCheck,
  draftMaintenanceWorkOrders,
  runForecastCycle,
  dispatchQueuedNotifications,
  recordTrendSnapshot,
} from '@factory/agents';
import { audit, query } from '@factory/db';
import { getSession } from '@/lib/session';
import { limit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/jobs/run — the daily agent sweep, on demand, for the signed-in
 * workspace (the Cmd+K "Run the daily agent sweep now" action). Same per-org
 * pipeline as the nightly cron: trajectory snapshot → digest → anomaly scan →
 * remediation/collections/compliance/maintenance drafts → outbound dispatch.
 * Skips the platform-wide pieces (connector sync, e-invoicing, pilot digests)
 * that stay cron/CI territory. Rate-limited per org (expensive, human-sized
 * usage) and audited like every other trust-path action.
 */
export async function POST() {
  const s = await getSession();
  if (s.orgId === 'none') return Response.json({ error: 'no org' }, { status: 400 });

  const rl = limit(`sweep:${s.orgId}`, 6, 600); // 6 sweeps / 10 min
  if (!rl.ok) {
    return Response.json({ error: `too many runs — retry in ${rl.retryAfterSec}s` }, { status: 429 });
  }

  const org = (await query<{ id: string; name: string }>('select id, name from organizations where id=$1', [s.orgId]))[0];
  if (!org) return Response.json({ error: 'org not found' }, { status: 404 });

  await recordTrendSnapshot(org.id); // trajectory snapshot (idempotent per day)

  const digest = await generateDigest(org.id);
  await query(
    `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'daily_digest',$3,'queued')`,
    [org.id, org.name, digest.channelDrafts.whatsapp]
  );

  let anomalies = 0;
  let urgent = 0;
  try {
    const report = await scanAnomalies(org.id);
    anomalies = report.anomalies.length;
    const high = report.anomalies.filter((a) => a.severity === 'high');
    urgent = high.length;
    if (high.length) {
      const body = [`🚨 *${org.name} — ${high.length} urgent issue${high.length > 1 ? 's' : ''}*`, '', ...high.map((a) => `🔴 ${a.title}`), '', high[0]!.detail].join('\n');
      await query(
        `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'anomaly_alert',$3,'queued')`,
        [org.id, org.name, body]
      );
    }
  } catch {
    // never fail the sweep on a scan error — same contract as the cron
  }

  let remediation = 'none';
  try {
    const r = await proposeTopRemediation(org.id);
    remediation = r.decision === 'skipped' ? `skipped (${r.reason})` : `${r.decision}${r.approvalId ? ` (${r.approvalId.slice(0, 8)}…)` : ''}`;
  } catch {
    /* keep going */
  }

  let collections = 'none due';
  try {
    const c = await batchDraftReminders(org.id);
    collections = c.count === 0 ? 'none due' : `${c.count} drafted (${c.decision})`;
  } catch {
    /* keep going */
  }

  let compliance = 'nothing eligible';
  try {
    const comp = await runComplianceCheck(org.id);
    compliance = comp.checked === 0 ? 'nothing eligible' : `${comp.generated.length} IRNs · ${comp.queuedForHuman.length} queued`;
  } catch {
    /* keep going */
  }

  let maintenance = 'none due';
  try {
    const m = await draftMaintenanceWorkOrders(org.id);
    maintenance = m.drafts.length === 0 ? 'none due' : `${m.drafts.length} WO drafted`;
  } catch {
    /* keep going */
  }

  // Monday rule matches the cron — ROP drafts stay weekly so approvals
  // don't pile up mid-week; the response says so plainly.
  const monday = new Date().getUTCDay() === 1;
  let forecast = monday ? 'skipped' : 'monday-only';
  try {
    if (monday) {
      const f = await runForecastCycle(org.id);
      forecast = f.suggestions.length === 0 ? 'no changes' : `${f.suggestions.length} ROP suggestions (${f.decision ?? 'none'})`;
    }
  } catch {
    /* keep going */
  }

  // explicit user intent = dispatch the outbox now (echo mode in dev)
  const dispatch = await dispatchQueuedNotifications(org.id);

  await audit(org.id, `user:${s.userName}`, 'jobs.manual_sweep', {
    metadata: { anomalies, urgent, dispatch: { sent: dispatch.sent, echoed: dispatch.echoed, failed: dispatch.failed } },
  });

  return Response.json({
    ok: true,
    overdue: digest.sections.find((x) => x.key === 'overdue')?.lines.length ?? 0,
    anomalies,
    urgent,
    remediation,
    collections,
    compliance,
    maintenance,
    forecast,
    dispatch: { sent: dispatch.sent, echoed: dispatch.echoed, failed: dispatch.failed },
  });
}
