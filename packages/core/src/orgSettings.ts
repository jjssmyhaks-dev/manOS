import { query } from '@factory/db';

/**
 * Per-org feature settings stored on organizations.settings (JSONB) —
 * no extra table needed. Shadow mode is the PRD v2 pilot default: every new
 * workspace starts with the agent drafting everything but executing nothing
 * until the owner flips the switch. Only an explicit shadow_mode:false goes
 * live, so existing orgs and fresh signups both land in shadow mode.
 */

export async function isShadowMode(orgId: string): Promise<boolean> {
  try {
    const rows = await query<{ shadow: string | null }>(
      `select coalesce(settings->>'shadow_mode', 'true') as shadow from organizations where id = $1 limit 1`,
      [orgId]
    );
    return rows[0]?.shadow !== 'false'; // pilot default ON; explicit false = live
  } catch {
    return false; // settings lookup must never block the policy engine
  }
}

export async function setShadowMode(orgId: string, enabled: boolean): Promise<void> {
  await query(
    `update organizations set settings = coalesce(settings,'{}'::jsonb) || $2::jsonb where id = $1`,
    [orgId, JSON.stringify({ shadow_mode: enabled })]
  );
}

// --- Pilot onboarding (3 steps: WhatsApp number, GSTIN, Tally/Zoho connector) ---

export type OnboardingStepKey = 'whatsapp' | 'gstin' | 'connector';

export interface OnboardingStep {
  key: OnboardingStepKey;
  label: string;
  hint: string;
  href: string;
  done: boolean;
}

export interface OnboardingStatus {
  shadowMode: boolean;
  startedAt: string | null;
  completedAt: string | null;
  steps: OnboardingStep[];
  doneCount: number;
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/** Guided setup checklist: WhatsApp number → GSTIN → accounting connector. */
export async function getOnboardingStatus(orgId: string, vertical: string): Promise<OnboardingStatus> {
  const orgRows = await query<{ settings: Record<string, unknown> | null }>(
    'select settings from organizations where id = $1 limit 1',
    [orgId]
  );
  const settings = (orgRows[0]?.settings ?? {}) as {
    gstin?: string;
    onboarding_started_at?: string;
    onboarding_completed_at?: string;
  };

  const notify = await query<{ owner_phone: string | null }>(
    'select owner_phone from notify_settings where org_id = $1 limit 1',
    [orgId]
  ).catch(() => [{ owner_phone: null } as { owner_phone: string | null }]);

  const conns = await query<{ type: string; status: string }>(
    `select type, status from connectors where org_id = $1 and type in ('tally','zoho_books','quickbooks')`,
    [orgId]
  ).catch(() => [] as Array<{ type: string; status: string }>);
  const connectorDone = conns.some((c) => c.status !== 'disconnected');

  const gstinDone = Boolean(settings.gstin && GSTIN_RE.test(settings.gstin));
  const whatsappDone = Boolean(notify[0]?.owner_phone);

  const steps: OnboardingStep[] = [
    {
      key: 'whatsapp',
      label: 'Add your WhatsApp number',
      hint: 'Where the daily summary, alerts and answers reach you.',
      href: '/settings',
      done: whatsappDone,
    },
    {
      key: 'gstin',
      label: 'Add your company GSTIN',
      hint: 'Unlocks e-invoices (IRN) and e-way bills on dispatch.',
      href: '/settings',
      done: gstinDone,
    },
    {
      key: 'connector',
      label: vertical === 'fabrication' ? 'Connect Tally or Zoho Books' : 'Connect Tally, Zoho Books or QuickBooks',
      hint: 'Your books stay the system of record — the agent syncs, never overwrites.',
      href: '/connectors',
      done: connectorDone,
    },
  ];

  return {
    shadowMode: await isShadowMode(orgId),
    startedAt: settings.onboarding_started_at ?? null,
    completedAt: settings.onboarding_completed_at ?? null,
    steps,
    doneCount: steps.filter((s) => s.done).length,
  };
}

/** Stamp when onboarding started (signup moment). */
export async function startOnboarding(orgId: string): Promise<void> {
  await query(
    `update organizations set settings = coalesce(settings,'{}'::jsonb)
       || jsonb_build_object('onboarding_started_at', coalesce(settings->>'onboarding_started_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')))
     where id = $1`,
    [orgId]
  ).catch(() => {}); // cosmetic timestamp; never block signup
}

/** Stamp when the owner finished (or skipped) the checklist. */
export async function completeOnboarding(orgId: string): Promise<void> {
  await query(
    `update organizations set settings = coalesce(settings,'{}'::jsonb)
       || jsonb_build_object('onboarding_completed_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
     where id = $1`,
    [orgId]
  );
}
