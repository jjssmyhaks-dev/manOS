import { query } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { executeAction } from './tools/write.js';

/**
 * Agent 12 — Customer Service (spec): inbound WhatsApp from a KNOWN customer
 * number (the webhook already resolves parties by phone) is answered with
 * order status or handled as a complaint/warranty claim. Read-only replies
 * are low risk (orgs may set auto); complaint tickets are writes routed to
 * the internal owner. Escalation guard: angry/escalating tone detection
 * hands over to a human IMMEDIATELY instead of letting the agent keep
 * replying, and multi-order customers are asked which order before any
 * status answer (disambiguation).
 */

const ANGRY_MARKERS = [
  'worst', 'pathetic', 'useless', 'fraud', 'cheat', 'legal action', 'consumer court', 'last warning',
  'bloody', 'idiot', 'nonsense', 'harassment', 'escala', 'complaint against you', 'ghatiya', 'bakwas',
];

export function isAngryTone(text: string): boolean {
  const t = text.toLowerCase();
  const hits = ANGRY_MARKERS.filter((m) => t.includes(m)).length;
  return hits >= 1 && (t.includes('!') || hits >= 2) || hits >= 2;
}

export interface CustomerOrderView {
  code: string | null;
  status: string | null;
  item: string | null;
  qty: number | null;
  amount: number | null;
  date: string | null;
  deliveryDate: string | null;
}

/** All recent orders for a customer (read; disambiguation list when >1). */
export async function getCustomerOrders(orgId: string, customerId: string, limit = 5): Promise<CustomerOrderView[]> {
  const rows = await query<{ code: string | null; status: string | null; item: string | null; qty: string | null; amount: string | null; date: string | null; delivery: string | null }>(
    `select e.code, e.status,
            coalesce((select coalesce(i.name, i.data->>'name') from entities i where i.id = e.item_id), null) as item,
            e.qty, e.amount, to_char(e.date, 'YYYY-MM-DD') as date,
            coalesce(e.data->>'deliveryDate', e.data->>'dueDate') as delivery
     from entities e
     where e.org_id=$1 and e.type='sales_order' and e.party_id=$2
     order by e.date desc limit $3`,
    [orgId, customerId, limit]
  );
  return rows.map((r) => ({
    code: r.code,
    status: r.status,
    item: r.item,
    qty: r.qty != null ? Number(r.qty) : null,
    amount: r.amount != null ? Number(r.amount) : null,
    date: r.date,
    deliveryDate: r.delivery,
  }));
}

function statusLine(o: CustomerOrderView): string {
  const bits = [`${o.code}`, o.item ?? 'order', o.qty != null ? `×${o.qty}` : '', `— ${o.status ?? 'unknown'}`];
  if (o.deliveryDate) bits.push(`(delivery ${o.deliveryDate})`);
  return bits.filter(Boolean).join(' ');
}

export interface CustomerServiceResult {
  reply: string;
  intent: 'status' | 'complaint' | 'greeting' | 'unclear';
  ticketId?: string;
  escalated?: boolean;
  decision?: string;
  approvalId?: string;
}

/** Full handler for an inbound customer message (already resolved to a party). */
export async function handleCustomerMessage(
  orgId: string,
  input: { customerId: string; customerName: string; text: string }
): Promise<CustomerServiceResult> {
  const t = input.text.toLowerCase();

  // spec edge case: angry/escalating → straight to a human
  if (isAngryTone(input.text)) {
    const ticket = await createComplaintTicket(orgId, {
      customerId: input.customerId,
      customerName: input.customerName,
      description: `[ESCALATED — tone] ${input.text.slice(0, 300)}`,
      escalated: true,
    });
    return {
      reply:
        `I'm sorry about the trouble — I've flagged this to our team right now (${ticket.code}) and a person will call you shortly.`,
      intent: 'complaint',
      ticketId: ticket.ticketId,
      escalated: true,
    };
  }

  const complainty = /problem|issue|complain|warranty|broken|damaged|defect|refund|replace|not working|kharab|tut/i.test(t);

  if (complainty) {
    const ticket = await createComplaintTicket(orgId, {
      customerId: input.customerId,
      customerName: input.customerName,
      description: input.text.slice(0, 500),
    });
    return {
      reply: `Sorry to hear that — I've logged it as ticket *${ticket.code}* and the team will get back to you. If it's urgent, reply here and I'll flag it to the owner directly.`,
      intent: 'complaint',
      ticketId: ticket.ticketId,
    };
  }

  // status intent: which order?
  const orders = await getCustomerOrders(orgId, input.customerId);
  if (!orders.length) {
    return { reply: `I couldn't find any orders for your number yet. If you have an invoice or order number, share it and I'll check.`, intent: 'unclear' };
  }
  const named = orders.find((o) => o.code && input.text.toUpperCase().includes(o.code.toUpperCase()));
  if (orders.length > 1 && !named) {
    return {
      reply: `You have ${orders.length} recent orders — which one?\n${orders.map((o) => `• ${statusLine(o)}`).join('\n')}`,
      intent: 'status',
    };
  }
  const chosen = named ?? orders[0]!;
  return {
    reply: `Order *${statusLine(chosen)}*. Anything else about it?`,
    intent: 'status',
  };
}

export interface ComplaintTicketResult {
  ticketId: string;
  code: string;
  decision?: string;
  approvalId?: string;
}

/** Complaint → complaint entity + a routing notification to the owner. */
export async function createComplaintTicket(
  orgId: string,
  input: { customerId: string; customerName: string; description: string; escalated?: boolean; orderId?: string }
): Promise<ComplaintTicketResult> {
  const rows = await query<{ id: string; code: string | null }>(
    `insert into entities (id, org_id, type, status, party_id, source, data)
     values (gen_random_uuid()::text, $1, 'complaint', $2, $3, 'agent', $4::jsonb) returning id, code`,
    [
      orgId,
      input.escalated ? 'escalated' : 'open',
      input.customerId,
      JSON.stringify({
        customer: input.customerName,
        description: input.description,
        orderId: input.orderId ?? null,
        escalated: Boolean(input.escalated),
        channel: 'whatsapp',
        createdAt: new Date().toISOString(),
      }),
    ]
  );
  const code = rows[0]!.code ?? rows[0]!.id.slice(0, 8);
  const body = input.escalated
    ? `🚨 *Escalated complaint ${code}* from ${input.customerName}:\n${input.description.slice(0, 200)}\nPlease call them today.`
    : `📋 *New complaint ${code}* from ${input.customerName}:\n${input.description.slice(0, 200)}`;
  await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'whatsapp_send',
      entityType: 'complaint',
      entityId: rows[0]!.id,
      payload: { message: body, template: 'complaint_route' },
      preview: `Notify owner about ${input.escalated ? 'ESCALATED ' : ''}complaint ${code}`,
      risk: 'external',
    },
    (pl) => executeAction(orgId, 'whatsapp_send', pl as Record<string, unknown>)
  );
  return { ticketId: rows[0]!.id, code, decision: 'queued', approvalId: undefined };
}
