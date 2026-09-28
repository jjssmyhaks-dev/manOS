import { runOrchestrator, ChatRequestSchema } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/chat — streaming orchestrator (PRD §10).
 * Auth + tenant context from session; body validated with Zod.
 */
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (session.orgId === 'none') {
      return Response.json({ error: 'no org' }, { status: 400 });
    }
    const raw = (await req.json()) as {
      messages?: Array<{ role: string; parts?: Array<{ type: string; text?: string }>; content?: string }>;
      conversationId?: string;
      channel?: 'web' | 'whatsapp';
    };
    const lastUser = [...(raw.messages ?? [])].reverse().find((m) => m.role === 'user');
    const text =
      lastUser?.parts?.filter((p) => p.type === 'text').map((p) => p.text ?? '').join(' ') ||
      lastUser?.content ||
      '';
    if (!text.trim()) return Response.json({ error: 'empty message' }, { status: 400 });

    const parsed = ChatRequestSchema.safeParse({
      orgId: session.orgId,
      role: session.role,
      conversationId: raw.conversationId,
      message: text,
      channel: raw.channel ?? 'web',
    });
    if (!parsed.success) {
      return Response.json({ error: 'invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    return await runOrchestrator(parsed.data);
  } catch (e) {
    console.error('chat error', e);
    return Response.json({ error: e instanceof Error ? e.message : 'chat failed' }, { status: 500 });
  }
}
