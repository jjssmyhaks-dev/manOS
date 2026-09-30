import { generateDigest, dispatchQueuedNotifications, getNotifySettings, scanAnomalies } from '@factory/agents';
import { connectorHealth } from '@factory/core';
import { query, audit } from '@factory/db';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/jobs/daily — durable-workflow entry (Vercel Cron in prod, see
 * vercel.json). For every org it:
 *   1. computes the daily digest and queues the WhatsApp send;
 *   2. runs connector health monitoring — error/stale Tally heartbeats and
 *      push backlogs are audited and surfaced as a web notification so
 *      failures show on the dashboard instead of dying silently.
 * GET /api/jobs/daily — monitoring-only snapshot (Vercel Cron hits GET).
 * Guarded by CRON_SECRET when set (Authorization: Bearer <secret>).
 */
async function guard(req: Request): Promise<Response | null> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return null;
}

export async function GET(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;
  const report = await runMonitoring();
  return Response.json({ ok: true, monitored: report.length, reports: report });
}

export async function POST(req: Request) {
  const denied = await guard(req);
  if (denied) return denied;

  const orgs = await query<{ id: string; name: string }>('select id, name from organizations');
  const results: Array<{ org: string; overdue: number; anomalies: number }> = [];
  for (const org of orgs) {
    const digest = await generateDigest(org.id);
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'daily_digest',$3,'queued')`,
      [org.id, org.name, digest.channelDrafts.whatsapp]
    );

    // urgent anomalies get their own alert (not buried in the digest)
    let anomalyCount = 0;
    try {
      const report = await scanAnomalies(org.id);
      anomalyCount = report.anomalies.length;
      const urgent = report.anomalies.filter((a) => a.severity === 'high');
      if (urgent.length) {
        const body = [`🚨 *${org.name} — ${urgent.length} urgent issue${urgent.length > 1 ? 's' : ''}*`, '', ...urgent.map((a) => `🔴 ${a.title}`), '', urgent[0]!.detail].join('\n');
        await query(
          `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'anomaly_alert',$3,'queued')`,
          [org.id, org.name, body]
        );
      }
    } catch {
      // never break the cron on a scan failure
    }
    results.push({ org: org.name, overdue: digest.sections.find((x) => x.key === 'overdue')?.lines.length ?? 0, anomalies: anomalyCount });
  }
  await audit(orgs[0]?.id ?? '00000000-0000-0000-0000-000000000000', 'system', 'jobs.daily_digest', { metadata: { orgs: results.length } });

  // deliver outbound WhatsApp (digests, reminders, alerts) for orgs with
  // auto_send on; others stay queued for the manual "Dispatch queued now" button
  let dispatch: Awaited<ReturnType<typeof dispatchQueuedNotifications>> | null = null;
  for (const org of orgs) {
    const ns = await getNotifySettings(org.id);
    if (!ns.autoSend) continue;
    dispatch = await dispatchQueuedNotifications(org.id);
  }

  const reports = await runMonitoring();
  return Response.json({ ok: true, results, monitored: reports.length, reports, dispatch });
}

/** Run connector health monitoring for every org; record failures in audit. */
async function runMonitoring(): Promise<Array<{ org: string; ok: boolean; failures: Array<{ type: string; issue: string; detail: string }> }>> {
  const orgs = await query<{ id: string; name: string }>('select id, name from organizations');
  const out: Array<{ org: string; ok: boolean; failures: Array<{ type: string; issue: string; detail: string }> }> = [];
  for (const org of orgs) {
    const report = await connectorHealth(org.id);
    if (!report.ok) {
      // Durable record (Audit page) + live surfacing (dashboard ConnectorHealthCard
      // re-derives health on every load, so cron-detected failures show there too).
      await audit(org.id, 'system', 'monitor.connector_health', { metadata: { failures: report.failures } });
    }
    out.push({ org: org.name, ok: report.ok, failures: report.failures });
  }
  return out;
}
