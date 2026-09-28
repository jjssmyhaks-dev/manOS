import { draftRemindersTool } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/collections — draft payment reminders for overdue invoices. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as { action: string; minDays?: number; limit?: number; channel?: 'whatsapp' | 'email' };

  if (body.action === 'draft_reminders') {
    const tool = draftRemindersTool({ orgId: s.orgId, role: s.role });
    const result = await tool.execute?.(
      { minDaysOverdue: body.minDays ?? 1, limit: body.limit ?? 10, channel: body.channel ?? 'whatsapp' },
      { messages: [], toolCallId: 'api' }
    );
    return Response.json({ ok: true, ...(result as object) });
  }
  return Response.json({ error: 'unknown action' }, { status: 400 });
}
