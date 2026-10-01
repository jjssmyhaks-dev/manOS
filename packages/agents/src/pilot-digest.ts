import { query } from '@factory/db';
import { overrideRateReport } from './override-rate.js';
import { forecastAccuracySummary, type ForecastAccuracySummary } from './forecast.js';

/**
 * Weekly pilot feedback digest — the case-study raw material (PRD v2 §8).
 * For every organisation it assembles: onboarding progress, adoption stats
 * (chats, documents, agent actions, undo rate), the override-rate trend
 * (the PRD exit metric), and the top correction themes mined from thumbs-down
 * activity and rejected approvals. Numbers are computed deterministically
 * in SQL; the "themes" are frequency counts from fixed keyword buckets, never
 * model output, so the digest runs with zero API keys (dev/CI) and never
 * invents figures.
 *
 * Operator-facing: sent to US, not the factory owner. The weekly cron queues
 * the rendered report into notifications under template 'pilot_digest' and
 * audits the run, so the case-study raw material accumulates per pilot week.
 */

export interface ThemeCount {
  theme: string;
  count: number;
}

export interface PilotDigestReport {
  orgId: string;
  orgName: string;
  vertical: string;
  asOf: string;
  onboarding: {
    startedAt: string | null;
    completedAt: string | null;
    stepsDone: number;
    stepsTotal: number;
    shadowMode: boolean;
  };
  usage: {
    chatsLast7d: number;
    documentsLast7d: number;
    actionsLast7d: number;
    actionsExecuted: number;
    undosLast7d: number;
    rejectionsLast7d: number;
    approvalsPending: number;
    feedbackUp: number;
    feedbackDown: number;
  };
  override: {
    trend: string;
    lastWeekPct: number | null;
    verdict: string;
  };
  /** A11 trust metric: projected vs actual demand — zero rows = not measured yet */
  forecastAccuracy: ForecastAccuracySummary;
  topCorrectionThemes: ThemeCount[];
  narrative: string[];
}

/** Keyword buckets for correction themes — kept deterministic and auditable. */
const THEME_KEYWORDS: Array<{ theme: string; words: string[] }> = [
  { theme: 'Prices / rates wrong', words: ['rate', 'price', '₹', 'quote', 'discount'] },
  { theme: 'Quantity / UoM mismatch', words: ['qty', 'quantity', ' kg', 'nos', 'uom'] },
  { theme: 'Wrong party / customer', words: ['customer', 'vendor', 'party', 'seller', 'buyer'] },
  { theme: 'Dates / deadlines off', words: ['date', 'due', 'deadline', 'late'] },
  { theme: 'Tone / wording of messages', words: ['tone', 'polite', 'wording', 'message', 'draft'] },
  { theme: 'Wrong document / invoice', words: ['invoice', 'po-', 'document', 'grn'] },
];

function classifyTheme(text: string): string {
  const t = text.toLowerCase();
  for (const b of THEME_KEYWORDS) {
    if (b.words.some((w) => t.includes(w))) return b.theme;
  }
  return 'Other';
}

export async function generatePilotDigest(orgId: string, orgName?: string, vertical?: string): Promise<PilotDigestReport> {
  const orgRows = await query<{ name: string; vertical: string; settings: Record<string, unknown> | null }>(
    'select name, vertical, settings from organizations where id = $1 limit 1',
    [orgId]
  );
  const org = orgRows[0];
  const name = orgName ?? org?.name ?? 'workspace';
  const vert = vertical ?? org?.vertical ?? 'fabrication';
  const settings = (org?.settings ?? {}) as {
    gstin?: string;
    onboarding_started_at?: string;
    onboarding_completed_at?: string;
    shadow_mode?: string;
  };

  const usageRows = await query<{
    chats: string;
    documents: string;
    actions: string;
    executed: string;
    undos: string;
    rejected: string;
    pending: string;
    up: string;
    down: string;
  }>(
    `select
       (select count(*) from conversations where org_id = $1 and created_at >= now() - interval '7 days') as chats,
       (select count(*) from documents where org_id = $1 and created_at >= now() - interval '7 days') as documents,
       (select count(*) from agent_actions where org_id = $1 and created_at >= now() - interval '7 days') as actions,
       (select count(*) from agent_actions where org_id = $1 and status = 'executed') as executed,
       (select count(*) from agent_actions where org_id = $1 and status = 'undone' and created_at >= now() - interval '7 days') as undos,
       (select count(*) from approvals where org_id = $1 and status = 'rejected' and created_at >= now() - interval '7 days') as rejected,
       (select count(*) from approvals where org_id = $1 and status = 'pending') as pending,
       (select count(*) from agent_actions where org_id = $1 and feedback = 'up') as up,
       (select count(*) from agent_actions where org_id = $1 and feedback = 'down') as down`,
    [orgId]
  );
  const u = usageRows[0]!;
  const usage = {
    chatsLast7d: Number(u.chats),
    documentsLast7d: Number(u.documents),
    actionsLast7d: Number(u.actions),
    actionsExecuted: Number(u.executed),
    undosLast7d: Number(u.undos),
    rejectionsLast7d: Number(u.rejected),
    approvalsPending: Number(u.pending),
    feedbackUp: Number(u.up),
    feedbackDown: Number(u.down),
  };

  // override-rate trend (the PRD §8 exit metric)
  const override = await overrideRateReport(orgId, 6).catch(() => ({
    trend: 'no-baseline' as string,
    lastWeek: undefined as { overrideRatePct: number } | undefined,
    verdict: 'Override baseline unavailable.',
  }));

  // top correction themes: thumbs-down feedback first, then rejections —
  // classified into buckets by keyword match (deterministic, no LLM)
  const correctionRows = await query<{ text: string }>(
    `select summary as text from agent_actions
      where org_id = $1 and feedback = 'down' and created_at >= now() - interval '28 days'
     union all
     select coalesce(preview, action_type) as text from approvals
      where org_id = $1 and status = 'rejected' and created_at >= now() - interval '28 days'
     limit 100`,
    [orgId]
  );
  const counts = new Map<string, number>();
  for (const r of correctionRows) {
    const theme = classifyTheme(r.text ?? '');
    counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  const topCorrectionThemes = [...counts.entries()]
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // onboarding step completeness from the same sources as getOnboardingStatus
  const notify = await query<{ owner_phone: string | null }>(
    'select owner_phone from notify_settings where org_id = $1 limit 1',
    [orgId]
  ).catch(() => [{ owner_phone: null } as { owner_phone: string | null }]);
  const conns = await query<{ c: string }>(
    `select count(*) as c from connectors where org_id = $1 and type in ('tally','zoho_books','quickbooks') and status != 'disconnected'`,
    [orgId]
  ).catch(() => [{ c: '0' }]);
  const stepsDone = [Boolean(notify[0]?.owner_phone), Boolean(settings.gstin), Number(conns[0]?.c ?? 0) > 0].filter(Boolean).length;

  const onboarding = {
    startedAt: settings.onboarding_started_at ?? null,
    completedAt: settings.onboarding_completed_at ?? null,
    stepsDone,
    stepsTotal: 3,
    // mirror isShadowMode's SQL semantics: coalesce(..., 'true') != 'false'
    // (the JSONB value may be a boolean or a string — normalise both)
    shadowMode: String(settings.shadow_mode ?? 'true') !== 'false',
  };

  const forecastAccuracy = await forecastAccuracySummary(orgId, 3).catch(() => ({
    scored: 0,
    averagePct: null as number | null,
    verdict: 'Forecast accuracy unavailable.',
    worst: [] as Array<{ item: string | null; weekStart: string; projectedUnits: number; actualUnits: number; accuracyPct: number }>,
  }));

  const narrative: string[] = [];
  narrative.push(
    usage.actionsLast7d === 0
      ? 'Quiet week — no agent actions. Worth a check-in call: is the team blocked on setup?'
      : `${usage.actionsLast7d} agent actions this week (${usage.actionsExecuted} executed lifetime), ${usage.chatsLast7d} chats and ${usage.documentsLast7d} documents processed.`
  );
  if (stepsDone < 3) {
    narrative.push(`Onboarding at ${stepsDone}/3 steps — nudge the remaining setup (WhatsApp / GSTIN / connector).`);
  } else if (!onboarding.completedAt) {
    narrative.push('All 3 setup steps done — send the "go live from shadow mode" note if they have not yet.');
  }
  narrative.push(override.verdict);
  if (forecastAccuracy.scored > 0 && forecastAccuracy.averagePct !== null) {
    narrative.push(
      `Forecast accuracy ${forecastAccuracy.averagePct}% over ${forecastAccuracy.scored} scored week${forecastAccuracy.scored > 1 ? 's' : ''}${
        forecastAccuracy.averagePct >= 85 ? ' — projections are landing.' : ' — reorder suggestions need owner review.'
      }`
    );
  }
  if (usage.feedbackDown > 0 || usage.rejectionsLast7d > 0) {
    const top = topCorrectionThemes[0];
    narrative.push(
      top
        ? `Corrections cluster around "${top.theme}" (${top.count} this month) — candidate for the eval set.`
        : 'Corrections this month have no dominant theme yet.'
    );
  } else if (usage.feedbackUp > 0) {
    narrative.push(`${usage.feedbackUp} 👍 so far — ask the owner which actions felt most trustworthy for the case study.`);
  }

  return {
    orgId,
    orgName: name,
    vertical: vert,
    asOf: new Date().toISOString(),
    onboarding,
    usage,
    override: {
      trend: override.trend,
      lastWeekPct: override.lastWeek?.overrideRatePct ?? null,
      verdict: override.verdict,
    },
    forecastAccuracy,
    topCorrectionThemes,
    narrative,
  };
}

/** Digest for every org (weekly cron entry point). */
export async function generateAllPilotDigests(): Promise<PilotDigestReport[]> {
  const orgs = await query<{ id: string; name: string; vertical: string }>(
    'select id, name, vertical from organizations order by created_at asc'
  );
  const out: PilotDigestReport[] = [];
  for (const o of orgs) {
    try {
      out.push(await generatePilotDigest(o.id, o.name, o.vertical));
    } catch {
      // one broken org must never kill the operator report
    }
  }
  return out;
}

/** WhatsApp/email text rendering for the notification queue. */
export function pilotDigestText(r: PilotDigestReport): string {
  const lines = [
    `📊 *Pilot feedback — ${r.orgName}* (${r.vertical})`,
    `Week of ${new Date(r.asOf).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    '',
    `*Setup:* ${r.onboarding.stepsDone}/${r.onboarding.stepsTotal} steps · shadow mode ${r.onboarding.shadowMode ? 'ON' : 'off'}${r.onboarding.completedAt ? ' · onboarding complete' : ''}`,
    `*Usage (7d):* ${r.usage.chatsLast7d} chats · ${r.usage.documentsLast7d} docs · ${r.usage.actionsLast7d} agent actions`,
    `*Trust:* ${r.usage.undosLast7d} undos · ${r.usage.rejectionsLast7d} rejections · override ${r.override.lastWeekPct ?? '–'}% (${r.override.trend})`,
    `*Pending approvals:* ${r.usage.approvalsPending} · 👍 ${r.usage.feedbackUp} / 👎 ${r.usage.feedbackDown}`,
    `*Forecast:* ${r.forecastAccuracy.scored === 0 ? 'not measured yet — snapshots started this week' : `${r.forecastAccuracy.averagePct}% avg vs actual (${r.forecastAccuracy.scored} wk)`}`,
  ];
  if (r.forecastAccuracy.worst.length) {
    lines.push('*Biggest forecast misses:*');
    for (const w of r.forecastAccuracy.worst.slice(0, 3)) {
      lines.push(`• ${w.item ?? '?'}: projected ${w.projectedUnits}, actual ${w.actualUnits} (${w.accuracyPct}%)`);
    }
  }
  if (r.topCorrectionThemes.length) {
    lines.push('*Top correction themes:*');
    for (const t of r.topCorrectionThemes) lines.push(`• ${t.theme} (${t.count})`);
  }
  lines.push('', ...r.narrative.map((n) => `— ${n}`));
  return lines.join('\n');
}
