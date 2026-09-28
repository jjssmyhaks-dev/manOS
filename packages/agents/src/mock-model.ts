import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCall,
} from '@ai-sdk/provider';

/**
 * Deterministic in-process mock LLM (AI_PROFILE=dev).
 *
 * Instead of faking an HTTP endpoint, this implements the AI SDK
 * LanguageModelV2 spec directly: it inspects the prompt, decides which real
 * tool to call (overdue / sales / stock / reorder), waits for the tool result,
 * then writes a business answer in the user's language (English/Hinglish).
 * Offline, free, stable for CI — and exercises the exact same tool path as a
 * production model.
 */

// --- prompt understanding ----------------------------------------------------

interface PlannedCall {
  toolName: string;
  input: Record<string, unknown>;
}

function classify(text: string): PlannedCall | null {
  const t = text.toLowerCase();
  const hasOverdue = /(overdue|outstanding|bakaya|udhaar|pending payment|receivab)/.test(t);
  const hasSales = /(sales|sale|bikri|revenue|orders (this|last)|this month)/.test(t);
  const hasStock = /(stock|inventory|bracket|item|sku|material)/.test(t);
  const hasReorder = /(reorder|low stock|below|shortage|restock)/.test(t);

  // most specific first
  if (hasReorder) return { toolName: 'reorder_check', input: {} };
  if (hasStock && /(in stock|stock of|how many|how much|available)/.test(t)) {
    // naive item-name extraction: quoted word(s) or noun after "is/for/of"
    const quoted = text.match(/["“']([^"”']{2,40})["”']/);
    const after = text.match(/(?:is|for|of|about)\s+([a-z0-9][a-z0-9 \-]{2,40}?)(?:\s+(?:in|available|stock|items?|brackets?|bracket)\b|$|\?)/i);
    const name = (quoted?.[1] ?? after?.[1] ?? '').trim();
    return { toolName: 'get_item_stock', input: name ? { itemName: name } : { itemName: t.split(/\s+/).slice(-2).join(' ') } };
  }
  if (hasOverdue) return { toolName: 'list_overdue', input: {} };
  if (hasSales) return { toolName: 'sales_summary', input: {} };
  return null;
}

// --- answer composition ------------------------------------------------------

function fmtInr(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function isHinglish(text: string): boolean {
  return /(kitni|kitna|hai|kya|batao|dikha|chahiye|humein|hamara|mera)/i.test(text);
}

interface OverdueLine { invoice: string | null; customer: string | null; amount: number; overdueDays: number }
interface StockItem { name?: string; stockOnHand?: number; reorderPoint?: number; suggestedQty?: number; uom?: string | null; low?: boolean }

function composeAnswer(planned: PlannedCall, result: unknown, userText: string): string {
  const hinglish = isHinglish(userText);
  const r = (result ?? {}) as Record<string, unknown>;

  if (planned.toolName === 'list_overdue') {
    const lines = (r.invoices ?? []) as OverdueLine[];
    const total = Number(r.total ?? 0);
    const count = Number(r.count ?? 0);
    if (!count) return hinglish ? 'Abhi koi overdue invoice nahi hai. Sab payments schedule par hain.' : 'No overdue invoices right now — all receivables are within terms.';
    const top = lines.slice(0, 5);
    const detail = top
      .map((l) => `• ${l.customer ?? 'Unknown'} — ${l.invoice ?? '—'} (${l.overdueDays}d): ${fmtInr(l.amount)}`)
      .join('\n');
    return hinglish
      ? `${count} overdue invoices hain, total ${fmtInr(total)}:\n${detail}\nBatao to main reminder drafts bana doon.`
      : `${count} overdue invoices totalling ${fmtInr(total)}:\n${detail}\nWant me to draft payment reminders?`;
  }

  if (planned.toolName === 'sales_summary') {
    const total = Number(r.totalSales ?? 0);
    const n = Number(r.orderCount ?? 0);
    const top = (r.topCustomers ?? []) as Array<{ customer?: string | null; amount?: number }>;
    const topLine = top.length
      ? ` Top: ${top.slice(0, 3).map((c) => `${c.customer ?? '?'} ${fmtInr(Number(c.amount ?? 0))}`).join(', ')}.`
      : '';
    return hinglish
      ? `Last ${r.windowDays ?? 30} din mein ${n} orders, bikri ${fmtInr(total)}.${topLine}`
      : `Last ${r.windowDays ?? 30} days: ${n} orders worth ${fmtInr(total)}.${topLine}`;
  }

  if (planned.toolName === 'get_item_stock') {
    const items = (r.items ?? []) as StockItem[];
    if (!items.length) return hinglish ? 'Ye item nahi mila. Naam ya code check kar do?' : "Couldn't find that item — check the name or code?";
    const it = items[0]!;
    const verdict = it.low ? 'below reorder point' : 'healthy';
    return hinglish
      ? `${it.name}: stock ${it.stockOnHand ?? 0} ${it.uom ?? ''} — reorder point ${it.reorderPoint ?? 0}. ${it.low ? 'Reorder karna chahiye.' : 'Stock theek hai.'}`
      : `${it.name}: ${it.stockOnHand ?? 0} ${it.uom ?? ''} on hand vs reorder point ${it.reorderPoint ?? 0} — ${verdict}.`;
  }

  if (planned.toolName === 'reorder_check') {
    const items = (r.items ?? []) as StockItem[];
    if (!items.length) return hinglish ? 'Koi item reorder point ke neeche nahi hai.' : 'No items are at or below the reorder point.';
    const lines = items.slice(0, 8).map((i) => `• ${i.name}: ${i.stockOnHand}/${i.reorderPoint} — suggest ${i.suggestedQty ?? ''} ${i.uom ?? ''}`.replace('  ', ' '));
    return hinglish
      ? `${items.length} items reorder ke liye:\n${lines.join('\n')}\nRFQ draft kar doon?`
      : `${items.length} items need reorder:\n${lines.join('\n')}\nShall I draft RFQs?`;
  }

  return 'Done. (mock model)';
}

// --- model implementation -----------------------------------------------------

export function createMockModel(): LanguageModelV2 {
  const id = 'mock-reasoning';
  return {
    specificationVersion: 'v2',
    provider: 'factory-mock',
    modelId: id,
    supportedUrls: {},
    async doGenerate(options) {
      const userText = lastUserText(options.prompt);
      const planned = classify(userText);
      if (!planned) {
        const text = fallbackText(userText);
        return {
          content: [{ type: 'text', text }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          warnings: [],
        };
      }
      const call: LanguageModelV2ToolCall = {
        type: 'tool-call',
        toolCallId: `mock_${Date.now().toString(36)}`,
        toolName: planned.toolName,
        input: JSON.stringify(planned.input),
      };
      return {
        content: [call],
        finishReason: 'tool-calls' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      };
    },
    async doStream(options) {
      const userText = lastUserText(options.prompt);
      const planned = classify(userText);

      // A queued tool call: compose the final answer from the tool result.
      if (planned && hasToolResult(options.prompt, planned.toolName)) {
        const result = findToolResult(options.prompt, planned.toolName);
        return streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', modelId: id },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: composeAnswer(planned, result, userText) },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        ]);
      }

      // No plan or a fresh tool loop turn: emit a tool call (or fallback text).
      if (planned) {
        const call: LanguageModelV2ToolCall = {
          type: 'tool-call',
          toolCallId: `mock_${Date.now().toString(36)}`,
          toolName: planned.toolName,
          input: JSON.stringify(planned.input),
        };
        return streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', modelId: id },
          call,
          { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        ]);
      }

      const text = fallbackText(userText);
      return streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', modelId: id },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      ]);
    },
  };
}

// --- prompt helpers -----------------------------------------------------------

function lastUserText(prompt: LanguageModelV2CallOptions['prompt']): string {
  let out = '';
  for (const m of prompt) {
    if (m.role !== 'user') continue;
    for (const part of m.content) {
      if (part.type === 'text') out = part.text; // keep last
    }
  }
  return out;
}

function findToolResult(prompt: LanguageModelV2CallOptions['prompt'], toolName: string): unknown {
  for (const m of prompt) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<{ type?: string; toolName?: string; output?: { type?: string; value?: unknown } }>) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output) {
        if (part.output.type === 'json' || part.output.type === 'error-json') return part.output.value;
        if (part.output.type === 'text') {
          try { return JSON.parse(String(part.output.value)); } catch { return part.output.value; }
        }
        return part.output.value;
      }
    }
    // assistant message content also carries tool-result parts in v5 prompts
  }
  return undefined;
}

function hasToolResult(prompt: LanguageModelV2CallOptions['prompt'], toolName: string): boolean {
  return findToolResult(prompt, toolName) !== undefined;
}

function fallbackText(userText: string): string {
  const hinglish = isHinglish(userText);
  const hasAction = /(reminder|rfq|purchase order| po |draft|bhej|bana)/i.test(userText);
  if (hasAction) {
    return hinglish
      ? 'Ye action main tool ke through draft karta hoon — thoda detail do (customer/item), phir approvals mein dikhega.'
      : 'I can draft that through the matching tool — give me the customer or item details and it will appear in Approvals.';
  }
  return hinglish
    ? 'Main sales, stock, overdue aur production ke baare mein data se jawab de sakta hoon. Kya dekhna hai?'
    : 'I can answer from your data on sales, stock, overdue receivables and production. What would you like to see?';
}

// --- tiny stream helper ---------------------------------------------------------

function streamOf(parts: LanguageModelV2StreamPart[]): { stream: ReadableStream<LanguageModelV2StreamPart> } {
  return { stream: new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  }) };
}

export type { LanguageModelV2Content };
