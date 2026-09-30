import { query } from '@factory/db';

/**
 * Override-rate metric (PRD v2 §8 exit criteria): the % of agent actions the
 * owner overrode per week — rejections of proposed fixes, rejections of
 * queued drafts, and undos, against executed actions. Baseline it in the
 * first pilot, then hold it under the agreed threshold X to justify
 * broadening scope.
 */

export interface WeekOverride {
  weekStart: string;
  executed: number;
  overridden: number;
  overrideRatePct: number;
  approvalsRejected: number;
  undos: number;
}

export interface OverrideReport {
  asOf: string;
  weeks: WeekOverride[];
  lastWeek?: WeekOverride;
  trend: 'improving' | 'worsening' | 'flat' | 'no-baseline';
  verdict: string;
}

export async function overrideRateReport(orgId: string, weeks = 6): Promise<OverrideReport> {
  const rows = await query<{
    week_start: string;
    executed: string;
    undone: string;
    rejected: string;
  }>(
    `with wk as (
       select date_trunc('week', d)::date as week_start
       from generate_series(current_date - ($2::int || ' weeks')::interval, current_date, interval '1 week') d
     )
     select to_char(wk.week_start, 'YYYY-MM-DD') as week_start,
            (select count(*) from agent_actions a
              where a.org_id = $1 and a.status = 'executed'
                and a.created_at >= wk.week_start and a.created_at < wk.week_start + 7) as executed,
            (select count(*) from agent_actions a
              where a.org_id = $1 and a.status = 'undone'
                and a.created_at >= wk.week_start and a.created_at < wk.week_start + 7) as undone,
            (select count(*) from approvals ap
              where ap.org_id = $1 and ap.status = 'rejected'
                and ap.created_at >= wk.week_start and ap.created_at < wk.week_start + 7) as rejected
     from wk order by wk.week_start`,
    [orgId, weeks - 1]
  );

  const out: WeekOverride[] = rows.map((r) => {
    const executed = Number(r.executed);
    const overridden = Number(r.undone) + Number(r.rejected);
    return {
      weekStart: r.week_start,
      executed,
      overridden,
      overrideRatePct: executed + overridden === 0 ? 0 : Math.round((overridden / (executed + overridden)) * 1000) / 10,
      approvalsRejected: Number(r.rejected),
      undos: Number(r.undone),
    };
  });

  const withActivity = out.filter((w) => w.executed + w.overridden > 0);
  let trend: OverrideReport['trend'] = 'no-baseline';
  if (withActivity.length >= 2) {
    const first = withActivity[0]!;
    const last = withActivity[withActivity.length - 1]!;
    if (last.overrideRatePct < first.overrideRatePct - 2) trend = 'improving';
    else if (last.overrideRatePct > first.overrideRatePct + 2) trend = 'worsening';
    else trend = 'flat';
  }

  const lastWeek = out[out.length - 1];
  const verdict = !withActivity.length
    ? 'No agent activity yet — the baseline starts as the pilot uses the product.'
    : trend === 'improving'
      ? 'Trust is growing: the owner overrides less each week.'
      : trend === 'worsening'
        ? 'Overrides are rising — worth a conversation about what the agent is getting wrong.'
        : 'Steady override rate — set the X threshold from this baseline.';

  return { asOf: new Date().toISOString(), weeks: out, lastWeek, trend, verdict };
}
