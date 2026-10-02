import {
  generateDigest,
  dispatchQueuedNotifications,
  getNotifySettings,
  scanAnomalies,
  proposeTopRemediation,
  runDueAgentJobs,
  generateAllPilotDigests,
  pilotDigestText,
  batchDraftReminders,
  runComplianceCheck,
  draftMaintenanceWorkOrders,
  runForecastCycle,
  type AgentJobRunResult,
} from '@factory/agents';
import { connectorHealth } from '@factory/core';
import { purgeExpiredSessions } from '@/lib/auth';
import { recordTrendSnapshot } from '@factory/agents';
import { query, audit } from '@factory/db';
import { parseZohoConfig, ZohoBooksConnector, parseQboConfig, QuickBooksConnector, parseTallyServerConfig, tallySync } from '@factory/connectors';
import { recordSyncHistory } from '@factory/core';
import { generateEInvoice } from '@factory/agents';

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
  const results: Array<{ org: string; overdue: number; anomalies: number; remediation: string; collections: string; compliance: string; maintenance: string; forecast: string }> = [];
  const jobResults: AgentJobRunResult[] = [];
  for (const org of orgs) {
    await recordTrendSnapshot(org.id); // trajectory snapshot (idempotent per day)
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

    // A4 collections: cooldown/promise-aware batched reminder drafts
    let collectionsNote = 'none';
    try {
      const c = await batchDraftReminders(org.id);
      collectionsNote = c.count === 0 ? 'none due' : `${c.count} drafted (${c.decision})`;
    } catch {
      // collections must never break the cron
    }

    // A10 compliance: e-invoice applicability → IRN with human queue on GSP errors
    let complianceNote = 'off';
    try {
      const comp = await runComplianceCheck(org.id);
      complianceNote = comp.checked === 0 ? 'nothing eligible' : `${comp.generated.length} IRNs · ${comp.queuedForHuman.length} queued`;
    } catch {
      // compliance must never break the cron
    }

    // A13 maintenance: PM work-order drafts for machines due
    let maintenanceNote = 'none';
    try {
      const m = await draftMaintenanceWorkOrders(org.id);
      maintenanceNote = m.drafts.length === 0 ? 'none due' : `${m.drafts.length} WO drafted`;
    } catch {
      // maintenance must never break the cron
    }

    // A11 forecasting (Mondays): reorder-point adjustment drafts
    let forecastNote = 'skipped';
    try {
      if (new Date().getUTCDay() === 1) {
        const f = await runForecastCycle(org.id);
        forecastNote = f.suggestions.length === 0 ? 'no changes' : `${f.suggestions.length} ROP suggestions (${f.decision ?? 'none'})`;
      }
    } catch {
      // forecasting must never break the cron
    }

    results.push({ org: org.name, overdue: digest.sections.find((x) => x.key === 'overdue')?.lines.length ?? 0, anomalies: anomalyCount, remediation: remediationNote, collections: collectionsNote, compliance: complianceNote, maintenance: maintenanceNote, forecast: forecastNote });
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

  // auto e-invoicing: dispatched B2B invoices get IRNs without anyone asking
  let einvoicing: Awaited<ReturnType<typeof runAutoEInvoicing>> | null = null;
  try {
    einvoicing = await runAutoEInvoicing();
  } catch (e) {
    console.error('auto e-invoicing failed:', e);
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

  // housekeeping: drop expired sessions so the table cannot grow unbounded
  let sessionsPurged = 0;
  try {
    sessionsPurged = await purgeExpiredSessions();
  } catch (e) {
    console.error('session purge failed:', e);
  }

  // weekly pilot feedback digest — the case-study raw material (queued as a
  // notification every Monday UTC; POST /api/jobs/pilot-digest forces a run)
  let pilotDigest: Awaited<ReturnType<typeof runPilotDigests>> | null = null;
  try {
    pilotDigest = await runPilotDigests();
  } catch (e) {
    console.error('pilot digest failed:', e);
  }

  return Response.json({
    ok: true, results, monitored: reports.length, reports, dispatch, agentJobs: jobResults.length,
    sessionsPurged,
    nightlySync: { synced: syncReport.synced.length, failures: syncReport.failures.length },
    einvoicing: einvoicing ? { generated: einvoicing.generated.length, skipped: einvoicing.skipped, failed: einvoicing.failures.length } : null,
    pilotDigest,
  });
}

/**
 * Weekly pilot feedback digest: usage stats + override trend + top correction
 * themes per org, queued for the operator under template 'pilot_digest'.
 * Runs on Mondays (UTC) inside the nightly cron; /api/jobs/pilot-digest
 * forces it any time.
 */
async function runPilotDigests(): Promise<{ day: string; orgs: number }> {
  const day = new Date().getUTCDay(); // 1 = Monday
  if (day !== 1) return { day: 'not-monday', orgs: 0 };
  const digests = await generateAllPilotDigests();
  for (const r of digests) {
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'email',$2,'pilot_digest',$3,'queued')`,
      [r.orgId, 'operator@factoryaios.in', pilotDigestText(r)]
    );
  }
  await audit(digests[0]?.orgId ?? '00000000-0000-0000-0000-000000000000', 'system', 'jobs.pilot_digest', {
    metadata: { orgs: digests.length },
  });
  return { day: 'monday', orgs: digests.length };
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
        let syncError: string | undefined;
        for (const entity of ['parties', 'items', 'invoices'] as const) {
          const r = await conn.sync(c.org_id, c.id, entity);
          pulled += r.pulled;
          syncError = syncError ?? r.errors[0];
        }
        await recordSyncHistory(c.org_id, 'zoho_books', pulled > 0 || !syncError, pulled, syncError, c.id);
        synced.push({ orgId: c.org_id, connector: 'Zoho Books', pulled });
      } else if (c.type === 'quickbooks') {
        const cfg = parseQboConfig(c.config);
        if (!cfg) continue;
        const conn = new QuickBooksConnector();
        let pulled = 0;
        let syncError: string | undefined;
        for (const entity of ['parties', 'items', 'invoices'] as const) {
          const r = await conn.sync(c.org_id, c.id, entity);
          pulled += r.pulled;
          syncError = syncError ?? r.errors[0];
        }
        await recordSyncHistory(c.org_id, 'quickbooks', pulled > 0 || !syncError, pulled, syncError, c.id);
        synced.push({ orgId: c.org_id, connector: 'QuickBooks', pulled });
      } else if (c.type === 'tally') {
        const cfg = parseTallyServerConfig(c.config);
        if (!cfg) continue; // desktop-agent tallies heartbeat on their own
        const r = await tallySync(c.org_id, c.id, cfg);
        const total = r.parties + r.items + r.vouchers;
        await recordSyncHistory(c.org_id, 'tally', total > 0 || r.errors.length === 0, total, r.errors[0], c.id);
        if (total === 0 && r.errors.length) {
          failures.push({ orgId: c.org_id, orgName: orgName.get(c.org_id) ?? 'workspace', connector: 'Tally', detail: r.errors[0] ?? 'no records pulled' });
        } else {
          synced.push({ orgId: c.org_id, connector: 'Tally', pulled: total });
        }
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message.slice(0, 200) : 'sync threw';
      await recordSyncHistory(c.org_id, c.type, false, 0, detail, c.id);
      failures.push({
        orgId: c.org_id,
        orgName: orgName.get(c.org_id) ?? 'workspace',
        connector: c.type,
        detail,
      });
    }
  }
  return { synced, failures };
}

/**
 * Auto e-invoicing: generate IRNs for dispatched B2B invoices that don't have
 * one. Failures collect into a single digest notification — never per-invoice
 * error spam. Skips invoices whose buyer has no valid GSTIN (not eligible).
 */
async function runAutoEInvoicing(): Promise<{ generated: string[]; skipped: number; failures: Array<{ invoice: string; reason: string }> }> {
  const generated: string[] = [];
  const skipped = { count: 0 };
  const failures: Array<{ invoice: string; reason: string }> = [];

  const gstinRe = '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$';
  const orgs = await query<{ id: string; name: string; gstin: string | null }>(
    `select id, name, settings->>'gstin' as gstin from organizations`
  );
  for (const org of orgs) {
    if (!org.gstin) continue; // e-invoicing not enabled for this org
    const invoices = await query<{ code: string | null }>(
      `select e.code from entities e
       join entities p on p.id = e.party_id
       where e.org_id = $1 and e.type = 'invoice'
         and e.status in ('dispatched', 'sent')
         and e.data->>'irn' is null
         and coalesce(p.data->>'gstin','') ~ $2
       order by e.date desc limit 25`,
      [org.id, gstinRe]
    );
    for (const inv of invoices) {
      if (!inv.code) continue;
      try {
        const res = await generateEInvoice(org.id, inv.code, 'system:cron');
        if (res.ok) generated.push(res.invoice ?? inv.code);
        else if (res.error?.includes('not set') || res.error?.includes('GSTIN')) skipped.count++;
        else failures.push({ invoice: res.invoice ?? inv.code, reason: (res.error ?? 'unknown').slice(0, 160) });
      } catch (e) {
        failures.push({ invoice: inv.code, reason: e instanceof Error ? e.message.slice(0, 160) : 'generation threw' });
      }
    }
  }

  if (failures.length) {
    const lines = failures.slice(0, 5).map((f) => `• ${f.invoice}: ${f.reason}`).join('\n');
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp',$2,'einvoice_digest',$3,'queued')`,
      [orgs[0]?.id ?? '00000000-0000-0000-0000-000000000000', orgs[0]?.name ?? 'owner', `🧾 *E-invoice nightly run:* ${generated.length} generated, ${failures.length} failed.\n${lines}${failures.length > 5 ? `\n…and ${failures.length - 5} more.` : ''}`]
    );
  }
  return { generated, skipped: skipped.count, failures };
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
