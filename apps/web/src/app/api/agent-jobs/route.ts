import { getSession } from '@/lib/session';
import { listAgentJobs, addAgentJob, setAgentJobEnabled, runAgentJobNow } from '@factory/agents';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * /api/agent-jobs — the agent's own recurring tasks, written in plain
 * language ("every friday chase overdue >15 days"). Daily cron executes due
 * jobs with full tool access; this endpoint manages them and offers
 * "run now" for testing.
 */

function parseSchedule(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (s === 'daily') return 'daily';
  const m = s.match(/^weekly[:\s-]*(\d)$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 7) return `weekly:${m[1]}`;
  return null;
}

export async function GET() {
  const s = await getSession();
  const jobs = await listAgentJobs(s.orgId);
  return Response.json({ jobs });
}

export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as {
    action: 'add' | 'enable' | 'run_now';
    schedule?: string;
    instruction?: string;
    jobId?: string;
    enabled?: boolean;
  };

  if (body.action === 'add') {
    const schedule = parseSchedule(body.schedule ?? '');
    if (!schedule) return Response.json({ error: "schedule must be 'daily' or 'weekly:1'…'weekly:7' (1=Mon)" }, { status: 400 });
    if (!body.instruction?.trim()) return Response.json({ error: 'instruction required' }, { status: 400 });
    const job = await addAgentJob(s.orgId, schedule, body.instruction.trim());
    return Response.json({ ok: true, job });
  }

  if (body.action === 'enable' && body.jobId) {
    await setAgentJobEnabled(s.orgId, body.jobId, body.enabled !== false);
    return Response.json({ ok: true });
  }

  if (body.action === 'run_now' && body.jobId) {
    const res = await runAgentJobNow(s.orgId, body.jobId);
    if (!res) return Response.json({ error: 'job not found' }, { status: 404 });
    return Response.json({ ok: res.ok, reply: res.reply, notified: res.notified, error: res.error });
  }

  return Response.json({ error: 'unknown action' }, { status: 400 });
}
