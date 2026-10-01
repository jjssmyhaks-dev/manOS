import { getOnboardingStatus } from '@factory/core';
import { overrideRateReport } from '@factory/agents';
import { query } from '@factory/db';
import { getSessionUser } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

/**
 * /pilot — the OPERATOR's cockpit (not shipped to factory owners): every pilot
 * workspace with onboarding progress, the override-rate trend and the latest
 * weekly digest side by side — the case-study tracking wall. Operator-only:
 * requires a signed-in session today (fine for the single-operator deploy);
 * tighten to an allowlist when the operator account is separated from pilots.
 */

export interface PilotRowData {
  orgId: string;
  orgName: string;
  vertical: string;
  createdAt: string | null;
  stepsDone: number;
  stepsTotal: number;
  shadowMode: boolean;
  overrideTrend: string;
  overrideLastWeekPct: number | null;
  pendingApprovals: number;
  actionsLast7d: number;
  feedbackUp: number;
  feedbackDown: number;
  lastDigest: string | null;
  lastDigestAt: string | null;
}

export default async function PilotDashboardPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="mx-auto max-w-md space-y-3 p-10 text-center">
        <h1 className="text-lg font-semibold">Operator dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Sign in to see pilot workspaces. This page is for the Factory AI OS team, not factory owners.
        </p>
        <a href="/signin" className="inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
          Sign in
        </a>
      </div>
    );
  }

  const orgs = await query<{ id: string; name: string; vertical: string; created_at: string }>(
    'select id, name, vertical, created_at from organizations order by created_at asc'
  );

  const rows: PilotRowData[] = [];
  for (const o of orgs) {
    const [status, override] = await Promise.all([
      getOnboardingStatus(o.id, o.vertical).catch(() => null),
      overrideRateReport(o.id, 6).catch(() => null),
    ]);
    const counts = await query<{ pending: string; actions: string; up: string; down: string }>(
      `select
         (select count(*) from approvals where org_id = $1 and status = 'pending') as pending,
         (select count(*) from agent_actions where org_id = $1 and created_at >= now() - interval '7 days') as actions,
         (select count(*) from agent_actions where org_id = $1 and feedback = 'up') as up,
         (select count(*) from agent_actions where org_id = $1 and feedback = 'down') as down`,
      [o.id]
    );
    const digest = await query<{ body: string; created_at: string }>(
      `select body, created_at::text from notifications where org_id = $1 and template = 'pilot_digest' order by created_at desc limit 1`,
      [o.id]
    );
    rows.push({
      orgId: o.id,
      orgName: o.name,
      vertical: o.vertical,
      createdAt: o.created_at,
      stepsDone: status?.doneCount ?? 0,
      stepsTotal: status?.steps.length ?? 3,
      shadowMode: status?.shadowMode ?? true,
      overrideTrend: override?.trend ?? 'no-baseline',
      overrideLastWeekPct: override?.lastWeek?.overrideRatePct ?? null,
      pendingApprovals: Number(counts[0]?.pending ?? 0),
      actionsLast7d: Number(counts[0]?.actions ?? 0),
      feedbackUp: Number(counts[0]?.up ?? 0),
      feedbackDown: Number(counts[0]?.down ?? 0),
      lastDigest: digest[0]?.body ?? null,
      lastDigestAt: digest[0]?.created_at ?? null,
    });
  }

  const trendBadge = (t: string) =>
    t === 'improving' ? 'success' : t === 'worsening' ? 'destructive' : t === 'flat' ? 'secondary' : 'outline';

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Pilot cockpit</h1>
        <p className="text-xs text-muted-foreground">
          Every workspace: onboarding progress, override trend (the PRD exit metric) and the latest weekly digest —
          case-study tracking in one wall. Operator-only.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {rows.map((r) => (
          <Card key={r.orgId}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {r.orgName} <span className="text-xs font-normal text-muted-foreground">· {r.vertical}</span>
                </span>
                <span className="flex gap-1.5">
                  {r.shadowMode && <Badge variant="warning">shadow</Badge>}
                  <Badge variant={trendBadge(r.overrideTrend)}>override {r.overrideLastWeekPct ?? '–'}% · {r.overrideTrend}</Badge>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Onboarding</span>
                  <span>
                    {r.stepsDone}/{r.stepsTotal}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${r.stepsDone === r.stepsTotal ? 'bg-emerald-500' : 'bg-primary'}`}
                    style={{ width: `${Math.round((r.stepsDone / r.stepsTotal) * 100)}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="rounded-md border px-2 py-1.5">
                  <div className="text-sm font-semibold">{r.actionsLast7d}</div>
                  <div className="text-[10px] text-muted-foreground">actions 7d</div>
                </div>
                <div className="rounded-md border px-2 py-1.5">
                  <div className="text-sm font-semibold">{r.pendingApprovals}</div>
                  <div className="text-[10px] text-muted-foreground">pending</div>
                </div>
                <div className="rounded-md border px-2 py-1.5">
                  <div className="text-sm font-semibold text-emerald-600">{r.feedbackUp}</div>
                  <div className="text-[10px] text-muted-foreground">👍</div>
                </div>
                <div className="rounded-md border px-2 py-1.5">
                  <div className="text-sm font-semibold text-red-600">{r.feedbackDown}</div>
                  <div className="text-[10px] text-muted-foreground">👎</div>
                </div>
              </div>

              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Latest weekly digest</span>
                  <span>{r.lastDigestAt ? new Date(r.lastDigestAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'none yet'}</span>
                </div>
                {r.lastDigest ? (
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-[11px] leading-snug text-muted-foreground">
                    {r.lastDigest}
                  </pre>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No digest yet — it lands every Monday (or POST /api/jobs/pilot-digest to force one).
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {rows.length === 0 && <p className="text-sm text-muted-foreground">No workspaces yet.</p>}
    </div>
  );
}
