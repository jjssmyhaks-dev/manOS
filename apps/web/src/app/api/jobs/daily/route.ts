import {
  generateDigest,
  dispatchQueuedNotifications,
  getNotifySettings,
  scanAnomalies,
  proposeTopRemediation,
  runDueAgentJobs,
  type AgentJobRunResult,
} from '@factory/agents';
import { connectorHealth } from '@factory/core';
import { query, audit } from '@factory/db';
import { parseZohoConfig, ZohoBooksConnector, parseQboConfig, QuickBooksConnector, parseTallyServerConfig, tallySync } from '@factory/connectors';

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
  const results: Array<{ org: string; overdue: number; anomalies: number; remediation: string }> = [];
  const jobResults: AgentJobRunResult[] = [];
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

    // closed-loop remediation: the worst finding becomes a draft action in
    // the approvals inbox (policy decides auto vs ask)
    let remediationNote = 'none';
    try {
      const r = await proposeTopRemediation(org.id);
      remediationNote = r.decision === 'skipped' ? `skipped (${r.reason})` : `${r.decision}${r.approvalId ? ` (${r.approvalId.slice(0, 8)}…)` : ''}`;
    } catch {
      // remediation must never break the cron
    }
    results.push({ org: org.name, overdue: digest.sections.find((x) => x.key === 'overdue')?.lines.length ?? 0, anomalies: anomalyCount, remediation: remediationNote });
  }

  // the agent's own schedule: NL recurring tasks due today, executed with tools
  try {
    jobResults.push(...(await runDueAgentJobs()));
  } catch (e) {
    console.error('agent jobs failed:', e);
  }

  // nightly connector sync: Tally/Zoho/QuickBooks data stays fresh without
  // anyone clicking "Sync now"; failures queue a WhatsApp alert instead of
  // dying silently (connectors that were never configured are skipped)
  const syncReport = await runNightlyConnectorSync();
  for (const f of syncReport.failures) {
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'connector_sync_alert',$3,'queued')`,
      [f.orgId, f.orgName, `🔌 *${f.connector} sync failed last night*\n${f.detail}\n\nOpen Connectors → Test connection to see what's wrong. Data may be going stale.`]
    );
  }
  await audit(orgs[0]?.id ?? '00000000-0000-0000-0000-000000000000', 'system', 'jobs.nightly_sync', {
    metadata: { synced: syncReport.synced.length, failures: syncReport.failures.length },
  });
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
  return Response.json({
    ok: true, results, monitored: reports.length, reports, dispatch, agentJobs: jobResults.length,
    nightlySync: { synced: syncReport.synced.length, failures: syncReport.failures.length },
  });
}

/** Nightly pull for every configured accounting connector; failures collected for alerts. */
async function runNightlyConnectorSync(): Promise<{
  synced: Array<{ orgId: string; connector: string; pulled: number }>;
  failures: Array<{ orgId: string; orgName: string; connector: string; detail: string }>;
}> {
  const synced: Array<{ orgId: string; connector: string; pulled: number }> = [];
  const failures: Array<{ orgId: string; orgName: string; connector: string; detail: string }> = [];

  const orgs = await query<{ id: string; name: string }>('select id, name from organizations');
  const connRows = await query<{ org_id: string; id: string; type: string; config: Record<string, unknown> }>(
    `select org_id, id, type, config from connectors where type in ('zoho_books','quickbooks','tally') and status != 'disconnected'`
  );
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  for (const c of connRows) {
    try {
      if (c.type === 'zoho_books') {
        const cfg = parseZohoConfig(c.config);
        if (!cfg) continue;
        const conn = new ZohoBooksConnector();
        let pulled = 0;
        for (const entity of ['parties', 'items', 'invoices'] as const) {
          pulled += (await conn.sync(c.org_id, c.id, entity)).pulled;
        }
        synced.push({ orgId: c.org_id, connector: 'Zoho Books', pulled });
      } else if (c.type === 'quickbooks') {
        const cfg = parseQboConfig(c.config);
        if (!cfg) continue;
        const conn = new QuickBooksConnector();
        let pulled = 0;
        for (const entity of ['parties', 'items', 'invoices'] as const) {
          pulled += (await conn.sync(c.org_id, c.id, entity)).pulled;
        }
        synced.push({ orgId: c.org_id, connector: 'QuickBooks', pulled });
      } else if (c.type === 'tally') {
        const cfg = parseTallyServerConfig(c.config);
        if (!cfg) continue; // desktop-agent tallies heartbeat on their own
        const r = await tallySync(c.org_id, c.id, cfg);
        const total = r.parties + r.items + r.vouchers;
        if (total === 0 && r.errors.length) {
          failures.push({ orgId: c.org_id, orgName: orgName.get(c.org_id) ?? 'workspace', connector: 'Tally', detail: r.errors[0] ?? 'no records pulled' });
        } else {
          synced.push({ orgId: c.org_id, connector: 'Tally', pulled: total });
        }
      }
    } catch (e) {
      failures.push({
        orgId: c.org_id,
        orgName: orgName.get(c.org_id) ?? 'workspace',
        connector: c.type,
        detail: e instanceof Error ? e.message.slice(0, 200) : 'sync threw',
      });
    }
  }
  return { synced, failures };
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
