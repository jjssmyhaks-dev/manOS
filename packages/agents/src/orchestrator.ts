import { streamText, stepCountIs } from 'ai';
import { z } from 'zod';
import { query, traceRun, meter } from '@factory/db';
import { getPack, toolAllowedForRole } from '@factory/core';
import { getModelForOrg, getModelConfig, getModelRoute, estimateCostInr, type AiConfigLookup } from './models.js';
import { listMetricKeysForPrompt } from './tools/read.js';
import { listFacts } from './memory.js';
import { readToolDefs } from './tools/read.js';
import { writeToolDefs } from './tools/write.js';
import type { AgentContext } from './tools/read.js';

/**
 * Orchestrator agent (PRD §6): one per conversation, AI SDK tool-calling loop
 * with specialist capabilities as tools. Deterministic first — business logic
 * lives in tools, the LLM explains results. Every run emits a trace + usage.
 * Two entrypoints share one pipeline: runOrchestrator streams UI messages for
 * the web chat; runOrchestratorToText resolves the final text for channels
 * that need a complete reply (WhatsApp).
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
  /** Org-level AI config lookup (defaults to the ai_config table). */
  aiConfigLookup?: AiConfigLookup;
}

/** Default lookup: per-org OpenRouter key/route from the ai_config table. */
export const dbAiConfigLookup: AiConfigLookup = {
  async get(orgId) {
    const rows = await query<{ api_key: string | null; model_route: string | null }>(
      'select api_key, model_route from ai_config where org_id = $1 limit 1',
      [orgId]
    );
    return rows[0];
  },
};

function systemPrompt(orgName: string, vertical: string, role: string, channel: 'web' | 'whatsapp' = 'web'): string {
  const pack = getPack(vertical);
  const lines = [
    `You are the AI operations agent for ${orgName}, an Indian MSME manufacturer (${pack.label} pack).`,
    pack.promptGuidance,
    '',
    'RULES:',
    '- Every number must come from a tool call (metrics/queries). Never compute or invent figures.',
    '- Answer in the user\'s language (English, Hindi or Hinglish). Be brief and business-like.',
    '- Show assumptions and the as-of date for data answers.',
    '- For any action (reminders, RFQs, POs), call the matching draft tool — it will route through approvals automatically. Never claim an outbound message was sent unless a tool result says so.',
    '- When the user states a preference, rule or correction ("always…", "never quote below…", "remember…"), save it with the remember tool and confirm briefly.',
    '- For questions no named metric covers, use ask_data with a table + grouping; never fabricate table or column names.',
    `- The current user role is '${role}'. Some tools are restricted by role.`,
  ];
  if (channel === 'whatsapp') {
    lines.push(
      '- The reply is delivered over WhatsApp: plain text only (no markdown, no tables, no bullet markers), friendly and under 1200 characters.'
    );
  }
  lines.push('', 'AVAILABLE METRIC KEYS (use with query_data):', listMetricKeysForPrompt());
  return lines.join('\n');
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
    if (!enabled.includes(name) && !['query_data', 'list_overdue', 'get_item_stock', 'sales_summary', 'reorder_check', 'run_mrp'].includes(name)) continue;
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

interface Prepared {
  started: number;
  org: { id: string; name: string; vertical: string };
  convoId: string;
  model: Parameters<typeof streamText>[0]['model'];
  modelDisplay: string;
  modelRoute: string;
  tools: ReturnType<typeof toolsForOrg>;
  memoryBlock: string;
}

/** Shared setup: org context, conversation persistence, model + tool resolution. */
async function prepareOrchestration(req: ChatRequest, deps: OrchestratorDeps): Promise<Prepared | null> {
  const started = Date.now();

  const orgRows = await query<{ id: string; name: string; vertical: string }>(
    'select id, name, vertical from organizations where id = $1 limit 1',
    [req.orgId]
  );
  const org = orgRows[0];
  if (!org) return null;

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

  const resolved = deps.model
    ? { model: deps.model, cfg: getModelConfig() }
    : await getModelForOrg(org.id, 'reasoning', deps.aiConfigLookup ?? dbAiConfigLookup);
  const tools = toolsForOrg({ vertical: org.vertical, role: req.role, ctx });

  // learning memory: active org facts are injected so the agent applies
  // previously learned rules ("don't quote below ₹350") without being asked
  let memoryBlock = '';
  try {
    const facts = await listFacts(org.id);
    if (facts.length) memoryBlock = `\nFACTS ABOUT THIS FACTORY (apply them; source: owner or past corrections):\n${facts.map((f) => `- ${f.fact}`).join('\n')}`;
  } catch {
    // memory must never break a chat
  }

  return {
    started,
    org,
    convoId: convoId!,
    model: resolved.model,
    modelDisplay: resolved.cfg.profile === 'prod' ? getModelRoute(resolved.cfg).reasoning : 'mock',
    modelRoute: String(resolved.cfg.route),
    tools,
    memoryBlock,
  };
}

function buildStreamOpts(req: ChatRequest, p: Prepared, deps: OrchestratorDeps) {
  return {
    model: p.model,
    system: systemPrompt(p.org.name, p.org.vertical, req.role, req.channel) + p.memoryBlock,
    messages: [
      ...(deps.history ?? []).map((h) => ({ role: h.role, content: h.text })),
      { role: 'user' as const, content: req.message },
    ],
    tools: p.tools,
    stopWhen: stepCountIs(8),
    temperature: 0.2,
    onError: ({ error }: { error: unknown }) => {
      console.error('orchestrator stream error:', error);
    },
    onFinish: async ({ finishReason, usage, response }: { finishReason: string; usage?: { inputTokens?: number; outputTokens?: number }; response: { messages?: unknown[] } }) => {
      const latencyMs = Date.now() - p.started;
      const toolCalls = (response.messages ?? [])
        .filter((m) => Array.isArray((m as { content?: unknown }).content) && ((m as { content: Array<{ type?: string }> }).content).some((c) => c.type === 'tool-call'))
        .flatMap((m) =>
          ((m as { content: Array<{ type: string; toolName?: string; input?: unknown; output?: unknown }> }).content)
            .filter((c) => c.type === 'tool-call')
            .map((c) => ({ tool: c.toolName, input: c.input, output: c.output }))
        );
      const tokensIn = usage?.inputTokens ?? 0;
      const tokensOut = usage?.outputTokens ?? 0;
      // platform-side AI: usage cost is attributed per org for subscription billing
      const costInr = p.modelDisplay === 'mock' ? 0 : estimateCostInr(p.modelRoute, 'reasoning', tokensIn + tokensOut);
      await traceRun({
        orgId: p.org.id,
        conversationId: p.convoId,
        agent: 'orchestrator',
        model: p.modelDisplay,
        input: { message: req.message },
        output: { finishReason },
        toolCalls,
        tokensIn,
        tokensOut,
        costInr,
        latencyMs,
        status: finishReason === 'error' ? 'error' : 'done',
      });
      await meter(p.org.id, 'chat', tokensIn + tokensOut, costInr);
    },
  };
}

/** Extract the assistant's text parts and persist them on the conversation. */
async function persistAssistant(result: { response: Promise<{ messages?: unknown[] }> }, orgId: string, convoId: string): Promise<void> {
  const msgs = ((await result.response).messages ?? []) as Array<{ content?: unknown }>;
  const text = msgs
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>) : []))
    .filter((c): c is { type: string; text?: string } => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  if (text) {
    await query(
      `insert into messages (conversation_id, org_id, role, content, parts) values ($1,$2,'assistant',$3,$4)`,
      [convoId, orgId, text, JSON.stringify(msgs)]
    );
  }
}

/** Web chat entrypoint: streaming UIMessage response. */
export async function runOrchestrator(
  req: ChatRequest,
  deps: OrchestratorDeps = {}
): Promise<Response> {
  const p = await prepareOrchestration(req, deps);
  if (!p) return Response.json({ error: 'org not found' }, { status: 404 });

  const result = streamText(buildStreamOpts(req, p, deps));

  // persist the assistant reply in the background; expose convoId header
  result.consumeStream().then(() => persistAssistant(result, p.org.id, p.convoId)).catch(() => {});

  return result.toUIMessageStreamResponse({
    headers: { 'x-conversation-id': p.convoId },
  });
}

export interface OrchestratorTextResult {
  conversationId: string;
  text: string;
}

/**
 * Channel entrypoint for transports that need the complete reply text
 * (WhatsApp webhook → sendWhatsAppText). Same pipeline, awaited to the end.
 */
export async function runOrchestratorToText(
  req: ChatRequest,
  deps: OrchestratorDeps = {}
): Promise<OrchestratorTextResult> {
  const p = await prepareOrchestration(req, deps);
  if (!p) throw new Error('org not found');
  const result = streamText(buildStreamOpts(req, p, deps));
  const text = await result.text;
  await persistAssistant(result, p.org.id, p.convoId);
  return { conversationId: p.convoId, text };
}

export { getModelRoute } from './models.js';
