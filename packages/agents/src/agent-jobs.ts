import { query, audit } from '@factory/db';
import { runOrchestratorToText } from './orchestrator.js';

/**
 * Scheduled agent tasks (the agent's own cron): owners describe recurring
 * work in one line — "every friday chase overdue invoices past 15 days",
 * "daily summarise machine downtime" — stored in agent_jobs. The daily cron
 * calls runDueAgentJobs(); each due job runs through the full orchestrator
 * (tools included, traces + metering as usual) and the outcome is delivered
 * to the owner's WhatsApp. Recurring jobs persist across days: weekly jobs
 * store their scheduled date and skip until that weekday returns.
 */

export interface AgentJob {
  id: string;
  org_id: string;
  schedule: string;
  instruction: string;
  enabled: boolean;
  last_run_at: string | null;
  last_result: Record<string, unknown> | null;
}

export interface AgentJobRunResult {
  jobId: string;
  orgId: string;
  ok: boolean;
  decision?: string;
  approvalId?: string | null;
  reply: string;
  notified: boolean;
  error?: string;
}

function isDue(job: AgentJob, now = new Date()): { due: boolean; reason: string } {
  const schedule = job.schedule.trim().toLowerCase();
  const isoDow = now.getDay() === 0 ? 7 : now.getDay();
  if (schedule === 'daily') return { due: true, reason: 'daily' };
  const weekly = schedule.match(/^weekly:(\d)$/);
  if (weekly) {
    const target = Number(weekly[1]);
    if (target < 1 || target > 7) return { due: false, reason: `invalid weekday ${weekly[1]}` };
    if (target !== isoDow) return { due: false, reason: `runs on weekday ${target}` };
    // skip if it already ran today
    if (job.last_run_at) {
      const last = new Date(job.last_run_at);
      if (last.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
        return { due: false, reason: 'already ran today' };
      }
    }
    return { due: true, reason: `weekly:${target} matches today` };
  }
  return { due: false, reason: `unknown schedule '${job.schedule}'` };
}

/** Owner phone for delivery, reusing notify_settings. */
async function ownerPhone(orgId: string): Promise<string | null> {
  const rows = await query<{ owner_phone: string | null }>(
    'select owner_phone from notify_settings where org_id = $1 limit 1',
    [orgId]
  );
  return rows[0]?.owner_phone ?? null;
}

/** Execute one agent job: full orchestrator run + WhatsApp delivery of the outcome. */
export async function runAgentJob(job: AgentJob): Promise<AgentJobRunResult> {
  const orgRows = await query<{ id: string; name: string }>(
    'select id, name from organizations where id = $1 limit 1',
    [job.org_id]
  );
  const org = orgRows[0];
  if (!org) {
    return { jobId: job.id, orgId: job.org_id, ok: false, reply: '', notified: false, error: 'org not found' };
  }

  let reply = '';
  try {
    const res = await runOrchestratorToText({
      orgId: org.id,
      role: 'owner',
      message: `Scheduled task (${job.schedule}): ${job.instruction}\nDo the work with your tools, then summarise what you did and any follow-up needed.`,
      channel: 'whatsapp',
    });
    reply = res.text;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await audit(org.id, 'system', 'agent_job.error', { entityId: job.id, metadata: { error } });
    await query('update agent_jobs set last_run_at = now(), last_result = $3::jsonb where id = $2 and org_id = $1', [org.id, job.id, JSON.stringify({ ok: false, error })]);
    return { jobId: job.id, orgId: org.id, ok: false, reply: '', notified: false, error };
  }

  // deliver the outcome to the owner's WhatsApp (queued; dispatch follows cron)
  const phone = await ownerPhone(org.id);
  await query(
    `insert into notifications (org_id, channel, to_addr, template, body, status)
     values ($1,'whatsapp',$2,'agent_job',$3,'queued')`,
    [org.id, phone ?? org.name, `📋 *${job.instruction.slice(0, 80)}*\n\n${reply.slice(0, 1200)}`]
  );
  await query(
    'update agent_jobs set last_run_at = now(), last_result = $3::jsonb where id = $2 and org_id = $1',
    [org.id, job.id, JSON.stringify({ ok: true, reply: reply.slice(0, 500) })]
  );
  await audit(org.id, 'system', 'agent_job.run', { entityId: job.id, metadata: { schedule: job.schedule, reply: reply.slice(0, 300) } });

  return { jobId: job.id, orgId: org.id, ok: true, reply, notified: true };
}

/** Run every enabled, due job across all orgs (called by the daily cron). */
export async function runDueAgentJobs(now = new Date()): Promise<AgentJobRunResult[]> {
  const jobs = await query<AgentJob>(
    'select id, org_id, schedule, instruction, enabled, last_run_at, last_result from agent_jobs where enabled = true'
  );
  const out: AgentJobRunResult[] = [];
  for (const job of jobs) {
    const { due, reason } = isDue(job, now);
    if (!due) continue;
    console.log(`[agent_jobs] running ${job.id} (${reason})`);
    out.push(await runAgentJob(job));
  }
  return out;
}

/** CRUD used by the settings API. */
export async function listAgentJobs(orgId: string): Promise<AgentJob[]> {
  return query<AgentJob>(
    'select id, org_id, schedule, instruction, enabled, last_run_at, last_result from agent_jobs where org_id = $1 order by created_at desc limit 50',
    [orgId]
  );
}

export async function addAgentJob(orgId: string, schedule: string, instruction: string): Promise<AgentJob> {
  const rows = await query<AgentJob>(
    `insert into agent_jobs (org_id, schedule, instruction) values ($1,$2,$3)
     returning id, org_id, schedule, instruction, enabled, last_run_at, last_result`,
    [orgId, schedule, instruction.slice(0, 500)]
  );
  return rows[0]!;
}

export async function setAgentJobEnabled(orgId: string, jobId: string, enabled: boolean): Promise<void> {
  await query('update agent_jobs set enabled = $3 where org_id = $1 and id = $2', [orgId, jobId, enabled]);
}

export async function runAgentJobNow(orgId: string, jobId: string): Promise<AgentJobRunResult | null> {
  const rows = await query<AgentJob>(
    'select id, org_id, schedule, instruction, enabled, last_run_at, last_result from agent_jobs where org_id = $1 and id = $2 limit 1',
    [orgId, jobId]
  );
  if (!rows[0]) return null;
  return runAgentJob(rows[0]);
}
