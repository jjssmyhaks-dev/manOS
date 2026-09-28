import { streamText, stepCountIs } from 'ai';
import { z } from 'zod';
import { query, traceRun, meter } from '@factory/db';
import { getPack, toolAllowedForRole } from '@factory/core';
import { getModel, getModelConfig, getModelRoute } from './models.js';
import { listMetricKeysForPrompt } from './tools/read.js';
import { readToolDefs } from './tools/read.js';
import { writeToolDefs } from './tools/write.js';
import type { AgentContext } from './tools/read.js';

/**
 * Orchestrator agent (PRD §6): one per conversation, AI SDK tool-calling loop
 * with specialist capabilities as tools. Deterministic first — business logic
 * lives in tools, the LLM explains results. Every run emits a trace + usage.
 */

export const ChatRequestSchema = z.object({
  orgId: z.string().min(1),
  role: z.string().default('owner'),
  conversationId: z.string().optional(),
  message: z.string().min(1).max(8000),
  channel: z.enum(['web', 'whatsapp']).default('web'),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface OrchestratorDeps {
  /** Override model for tests/evals. */
  model?: Parameters<typeof streamText>[0]['model'];
  /** Prior conversation turns (role + text) for follow-up context. */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
}

function systemPrompt(orgName: string, vertical: string, role: string): string {
  const pack = getPack(vertical);
  return [
    `You are the AI operations agent for ${orgName}, an Indian MSME manufacturer (${pack.label} pack).`,
    pack.promptGuidance,
    '',
    'RULES:',
    '- Every number must come from a tool call (metrics/queries). Never compute or invent figures.',
    '- Answer in the user\'s language (English, Hindi or Hinglish). Be brief and business-like.',
    '- Show assumptions and the as-of date for data answers.',
    '- For any action (reminders, RFQs, POs), call the matching draft tool — it will route through approvals automatically. Never claim an outbound message was sent unless a tool result says so.',
    `- The current user role is '${role}'. Some tools are restricted by role.`,
    '',
    'AVAILABLE METRIC KEYS (use with query_data):',
    listMetricKeysForPrompt(),
  ].join('\n');
}

/** Filter tools by role allow-list and org's pack. */
export function toolsForOrg(opts: { vertical: string; role: string; ctx: AgentContext; enabledTools?: string[] }) {
  const pack = getPack(opts.vertical);
  const read = readToolDefs(opts.ctx);
  const write = writeToolDefs(opts.ctx);
  const all = { ...read, ...write };
  const enabled = opts.enabledTools ?? pack.tools;
  const out: Record<string, (typeof all)[keyof typeof all]> = {};
  for (const [name, t] of Object.entries(all)) {
    if (!enabled.includes(name) && !['query_data', 'list_overdue', 'get_item_stock', 'sales_summary', 'reorder_check'].includes(name)) continue;
    if (!toolAllowedForRole(opts.role, name)) continue;
    // surface tool-execute failures in server logs (SDK redacts them in the stream)
    const tool = t as typeof t & { execute?: (...a: never[]) => Promise<unknown> };
    if (typeof tool.execute === 'function') {
      const orig = tool.execute.bind(tool);
      (tool as { execute: unknown }).execute = async (...a: never[]) => {
        try {
          return await orig(...a);
        } catch (e) {
          console.error(`tool '${name}' execute failed:`, e);
          throw e;
        }
      };
    }
    out[name] = tool as (typeof all)[keyof typeof all];
  }
  return out;
}

export async function runOrchestrator(
  req: ChatRequest,
  deps: OrchestratorDeps = {}
): Promise<Response> {
  const started = Date.now();
  const cfg = getModelConfig();

  // org + vertical context
  const orgRows = await query<{ id: string; name: string; vertical: string }>(
    'select id, name, vertical from organizations where id = $1 limit 1',
    [req.orgId]
  );
  const org = orgRows[0];
  if (!org) return Response.json({ error: 'org not found' }, { status: 404 });

  const ctx: AgentContext = { orgId: org.id, role: req.role, conversationId: req.conversationId };

  // persist conversation + user message
  let convoId = req.conversationId;
  if (!convoId) {
    const rows = await query<{ id: string }>(
      `insert into conversations (org_id, channel, title) values ($1,$2,$3) returning id`,
      [org.id, req.channel, req.message.slice(0, 60)]
    );
    convoId = rows[0]!.id;
  } else {
    await query(
      `insert into messages (conversation_id, org_id, role, content) values ($1,$2,'user',$3)`,
      [convoId, org.id, req.message]
    );
  }

  const model = deps.model ?? getModel('reasoning');
  const tools = toolsForOrg({ vertical: org.vertical, role: req.role, ctx });

  const result = streamText({
    model,
    system: systemPrompt(org.name, org.vertical, req.role),
    messages: [
      ...(deps.history ?? []).map((h) => ({ role: h.role, content: h.text })),
      { role: 'user' as const, content: req.message },
    ],
    tools,
    stopWhen: stepCountIs(8),
    temperature: 0.2,
    onError: ({ error }) => {
      console.error('orchestrator stream error:', error);
    },
    onFinish: async ({ finishReason, usage, response }) => {
      const latencyMs = Date.now() - started;
      const toolCalls = (response.messages ?? [])
        .filter((m) => Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === 'tool-call'))
        .flatMap((m) =>
          (m.content as Array<{ type: string; toolName?: string; input?: unknown; output?: unknown }>)
            .filter((c) => c.type === 'tool-call')
            .map((c) => ({ tool: c.toolName, input: c.input, output: c.output }))
        );
      const tokensIn = usage?.inputTokens ?? 0;
      const tokensOut = usage?.outputTokens ?? 0;
      await traceRun({
        orgId: org.id,
        conversationId: convoId,
        agent: 'orchestrator',
        model: cfg.profile === 'prod' ? getModelRoute(cfg).reasoning : 'mock',
        input: { message: req.message },
        output: { finishReason },
        toolCalls,
        tokensIn,
        tokensOut,
        costInr: 0,
        latencyMs,
        status: finishReason === 'error' ? 'error' : 'done',
      });
      await meter(org.id, 'chat', tokensIn + tokensOut, 0);
    },
  });

  // persist the assistant reply in the background; expose convoId header
  result.consumeStream().then(async () => {
    const msgs = (await result.response).messages;
    const text = msgs
      .flatMap((m: { content?: unknown }) => (Array.isArray(m.content) ? m.content : []))
      .filter((c: { type?: string }): c is { type: string; text?: string } => c.type === 'text')
      .map((c: { text?: string }) => c.text ?? '')
      .join('');
    if (text) {
      await query(
        `insert into messages (conversation_id, org_id, role, content, parts) values ($1,$2,'assistant',$3,$4)`,
        [convoId, org.id, text, JSON.stringify(msgs)]
      );
    }
  }).catch(() => {});

  return result.toUIMessageStreamResponse({
    headers: { 'x-conversation-id': convoId ?? '' },
  });
}

export { getModelRoute } from './models.js';
