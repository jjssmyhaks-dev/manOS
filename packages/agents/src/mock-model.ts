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

function classify(text: string, priorAssistant = ''): PlannedCall | null {
  const t = text.toLowerCase();

  // --- write intents (highest priority) --------------------------------------
  if (/(reminder|remind|yaad|payment follow)/.test(t)) {
    const minDays = Number(t.match(/(\d+)\s*(day|din)/)?.[1] ?? 0);
    return { toolName: 'draft_reminders', input: minDays ? { minDaysOverdue: minDays } : {} };
  }
  if (/(rfq|quote|quotation)/.test(t)) {
    const names = t.match(/(?:for|of)\s+([a-z0-9][a-z0-9 \-]{2,40})/);
    return { toolName: 'draft_rfq', input: names?.[1]?.trim() ? { itemNames: [names[1].trim()] } : {} };
  }
  if (/(create|raise|make|draft|bana)\b.*\bpo\b|purchase order/.test(t)) {
    const item = t.match(/(?:of|for)\s+([a-z0-9][a-z0-9 \-]{2,40})/);
    const qty = Number(t.match(/(\d+)\s*(nos|pcs|kg|ltr|units?)\b/)?.[1] ?? 0);
    const rate = Number(t.match(/@?\s*(?:rs\.?|₹)\s*(\d+)/)?.[1] ?? 0);
    return { toolName: 'create_po_draft', input: { vendorName: '', itemName: item?.[1]?.trim() ?? '', qty, rate } };
  }
  if (/(shift|job card|job-card|output|production log)/.test(t)) {
    const code = t.match(/jc[-\s]?(\d+)/i)?.[1];
    const qty = Number(t.match(/(\d+)\s*(nos|pcs|units?)\b/)?.[1] ?? 0);
    return { toolName: 'log_shift_output', input: { jobCardCode: code ? `JC-${code}` : '', outputQty: qty } };
  }

    // --- confirm follow-up: prior assistant offered a draft --------------------
  const confirmation = /^(yes|yeah|yep|ok|okay|haan|ha|kar do|kardo|proceed|go ahead|sure|please do|do it)\b/.test(t.trim());
  if (confirmation) {
    const prior = priorAssistant.toLowerCase();
    if (/(draft rfq|rfq draft|rfq bana|draft rfqs)/.test(prior)) return { toolName: 'draft_rfq', input: {} };
    if (/(draft payment reminders|reminder drafts|reminders bana|draft reminders)/.test(prior)) return { toolName: 'draft_reminders', input: {} };
  }

  // --- metric routing --------------------------------------------------------
  if (/(top|best)\s+(customers?|parties|buyers)/.test(t) || /customer.*sales|sales.*by customer/.test(t))
    return { toolName: 'query_data', input: { metricKey: 'sales_by_customer_30d' } };
  if (/(open|pending|running)\s+(jobs?|job cards?)/.test(t) || /wip/.test(t))
    return { toolName: 'query_data', input: { metricKey: 'open_job_cards' } };
  if (/(delayed|late).*(orders?|deliver)/.test(t))
    return { toolName: 'query_data', input: { metricKey: 'top_delayed_orders' } };
  if (/(cash|collections?|payments? received)/.test(t))
    return { toolName: 'query_data', input: { metricKey: 'cash_position' } };
  if (/(stock value|inventory value|valuation)/.test(t))
    return { toolName: 'query_data', input: { metricKey: 'stock_value' } };
  if (/(receivable|total outstanding|collections pending)/.test(t))
    return { toolName: 'query_data', input: { metricKey: 'receivables_total' } };

  // --- read intents ----------------------------------------------------------
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

const METRIC_LABELS: Record<string, (r: Record<string, unknown>) => string> = {
  sales_by_customer_30d: (r) => {
    const rows = (r.breakdown ?? []) as Array<{ customer?: string; total?: number }>;
    const total = Number(r.value ?? 0);
    const lines = rows.slice(0, 5).map((x) => `• ${x.customer ?? '?'}: ${fmtInr(Number(x.total ?? 0))}`);
    return `Sales (30d) ${fmtInr(total)}:\n${lines.join('\n')}`;
  },
  open_job_cards: (r) => {
    const rows = (r.breakdown ?? []) as Array<{ status?: string; machine?: string; count?: number }>;
    return `Open job cards: ${Number(r.value ?? 0)}\n${rows.slice(0, 6).map((x) => `• ${x.status ?? '?'} @ ${x.machine ?? '?'}: ${x.count ?? 0}`).join('\n')}`;
  },
  top_delayed_orders: (r) => {
    const rows = (r.breakdown ?? []) as Array<{ order?: string; customer?: string; daysLate?: number }>;
    const lines = rows.slice(0, 6).map((x) => `• ${x.order ?? '?'} — ${x.customer ?? '?'} (${x.daysLate ?? 0}d late)`);
    return `Delayed orders: ${Number(r.value ?? 0)}\n${lines.join('\n')}`;
  },
  cash_position: (r) => `Cash collected (30d): ${fmtInr(Number(r.value ?? 0))}`,
  stock_value: (r) => `Stock valuation: ${fmtInr(Number(r.value ?? 0))}`,
  receivables_total: (r) => `Total receivables: ${fmtInr(Number(r.value ?? 0))}`,
};

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
    const items = (r.items ?? []) as Array<StockItem & { item?: string | null }>;
    if (!items.length) return hinglish ? 'Koi item reorder point ke neeche nahi hai.' : 'No items are at or below the reorder point.';
    const lines = items.slice(0, 8).map((i) => `• ${i.item ?? i.name ?? 'item'}: ${i.stockOnHand ?? 0}/${i.reorderPoint ?? 0} — suggest ${i.suggestedQty ?? ''} ${i.uom ?? ''}`.replace(/\s+/g, ' '));
    return hinglish
      ? `${items.length} items reorder ke liye:\n${lines.join('\n')}\nRFQ draft kar doon?`
      : `${items.length} items need reorder:\n${lines.join('\n')}\nShall I draft RFQs?`;
  }

  if (planned.toolName === 'query_data') {
    const key = String(r.metric ?? planned.input.metricKey);
    const renderer = METRIC_LABELS[key];
    if (renderer) return `${renderer(r)}\n(as of ${String(r.asOf ?? 'today')})`;
    return `${key}: ${String(r.value ?? 'n/a')} ${String(r.unit ?? '')}`;
  }

  if (planned.toolName === 'draft_reminders' || planned.toolName === 'draft_rfq') {
    const count = Number(r.queuedCount ?? 0);
    const details = (r.details ?? []) as string[];
    if (!count) return hinglish ? 'Kuch bhi queue nahi hua — shayad sab already processed hain.' : 'Nothing was queued — items may already be processed.';
    const lines = details.slice(0, 6).map((d) => `• ${d}`);
    return hinglish
      ? `${count} actions approvals inbox mein bheje gaye:\n${lines.join('\n')}\nApprovals page se approve karo.`
      : `${count} actions queued in the approvals inbox:\n${lines.join('\n')}\nReview them on the Approvals page.`;
  }

  if (planned.toolName === 'create_po_draft') {
    const decision = String((r as { decision?: string }).decision ?? 'unknown');
    if (decision === 'auto') return 'PO created (auto-approved by policy). Tally push queued for the connector.';
    return `PO request is ${decision}: ${String((r as { reason?: string }).reason ?? '')}`;
  }

  if (planned.toolName === 'log_shift_output') {
    const rr = r as { decision?: string; reason?: string; ok?: boolean; error?: string };
    if (rr.ok === false) return `Couldn't log output: ${rr.error ?? 'unknown error'}`;
    return `Shift output is ${rr.decision ?? 'queued'}: ${rr.reason ?? ''}`;
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
      const planned = classify(userText, priorAssistantText(options.prompt));
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
      const planned = classify(userText, priorAssistantText(options.prompt));

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

/** Concatenated text of prior assistant messages (for confirm follow-ups). */
function priorAssistantText(prompt: LanguageModelV2CallOptions['prompt']): string {
  let out = '';
  for (const m of prompt) {
    if (m.role !== 'assistant') continue;
    for (const part of m.content) {
      if (part.type === 'text') out += ` ${part.text}`;
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
