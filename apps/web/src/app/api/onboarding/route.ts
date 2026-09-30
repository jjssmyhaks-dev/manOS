import { getOnboardingStatus, completeOnboarding } from '@factory/core';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/** GET /api/onboarding — guided-setup checklist status (3 steps + shadow mode). */
export async function GET() {
  const s = await getSession();
  const status = await getOnboardingStatus(s.orgId, s.vertical);
  return Response.json({
    orgName: s.orgName,
    shadowMode: status.shadowMode,
    steps: status.steps,
    doneCount: status.doneCount,
    completedAt: status.completedAt,
  });
}

/** POST /api/onboarding — { action: 'complete' } hides the checklist. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action === 'complete') {
    await completeOnboarding(s.orgId);
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'unknown action' }, { status: 400 });
}
