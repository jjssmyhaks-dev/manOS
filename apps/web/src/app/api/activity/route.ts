import { getSession } from '@/lib/session';
import { listActivity, undoAgentAction, setActionFeedback, withinUndoWindow } from '@factory/agents';

export const runtime = 'nodejs';

/** GET /api/activity — the AI activity timeline (F4 trust layer). */
export async function GET(req: Request) {
  const s = await getSession();
  const url = new URL(req.url);
  const search = url.searchParams.get('q') ?? undefined;
  const rows = await listActivity(s.orgId, { search, limit: 100 });
  return Response.json({
    actions: rows.map((r) => ({
      ...r,
      undoWindow: withinUndoWindow(r) ? r.executed_at : null,
    })),
  });
}

/** POST /api/activity — undo an executed action, or leave thumbs feedback. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as {
    action: 'undo' | 'feedback';
    id?: string;
    feedback?: 'up' | 'down';
  };

  if (body.action === 'undo' && body.id) {
    const res = await undoAgentAction(s.orgId, body.id, `user:${s.userName}`);
    return Response.json(res.ok ? { ...res } : { ok: false, error: res.error }, { status: res.ok ? 200 : 409 });
  }

  if (body.action === 'feedback' && body.id && body.feedback) {
    await setActionFeedback(s.orgId, body.id, body.feedback);
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'unknown action' }, { status: 400 });
}
