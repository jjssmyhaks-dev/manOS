import { runOrchestrator, ChatRequestSchema } from '@factory/agents';
import { getSession } from '@/lib/session';
import { limit, clientKey } from '@/lib/rate-limit';

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
    // LLM spend guard: 20 messages/min per org on the streaming chat
    const rl = limit(`org:${session.orgId}`, 20, 60);
    if (!rl.ok) {
      return Response.json({ error: `Rate limit — retry in ${rl.retryAfterSec}s.` }, { status: 429 });
    }
    const raw = (await req.json()) as {
      messages?: Array<{ role: string; parts?: Array<{ type: string; text?: string }>; content?: string }>;
      conversationId?: string;
      channel?: 'web' | 'whatsapp';
    };
    const uiMessages = raw.messages ?? [];
    const lastUser = [...uiMessages].reverse().find((m) => m.role === 'user');
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

    // prior turns for follow-up context ("yes, do it") — text parts only,
    // excluding the final user message (passed as `message`)
    const prior = uiMessages.slice(0, -1);
    const history = prior
      .map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        text:
          m.parts?.filter((p) => p.type === 'text').map((p) => p.text ?? '').join(' ') ||
          m.content ||
          '',
      }))
      .filter((h) => h.text.trim().length > 0)
      .slice(-10);

    return await runOrchestrator(parsed.data, { history });
  } catch (e) {
    console.error('chat error', e);
    return Response.json({ error: e instanceof Error ? e.message : 'chat failed' }, { status: 500 });
  }
}
