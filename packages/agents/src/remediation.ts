import { query, audit } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { scanAnomalies, type Anomaly } from './anomalies.js';
import { executeAction } from './tools/write.js';

/**
 * Closed-loop remediation (the agent proposes, the owner decides, the system
 * executes): every high/medium anomaly gets a concrete draft action — a
 * payment reminder for receivables spikes, an RFQ for stock-side findings,
 * a vendor escalator for price variances — routed through the same policy
 * engine (auto executes, ask queues an approval) so nothing bypasses the
 * human-in-the-loop. Deciding the approval re-enters here via decideProposal,
 * which executes and records the outcome against the originating finding.
 */

export interface RemediationProposal {
  anomalyKind: Anomaly['kind'];
  title: string;
  actionType: string;
  payload: Record<string, unknown>;
  preview: string;
  risk: 'write' | 'external';
  rationale: string;
}

interface ResolvedInvoice {
  id: string;
  invoice: string | null;
  customerId: string | null;
  customer: string | null;
  amount: number;
  overdueDays: number;
}

async function resolveWorstOverdue(orgId: string): Promise<ResolvedInvoice | null> {
  const rows = await query<{ id: string; code: string | null; party_id: string | null; amount: string; overdue_days: string; customer: string | null }>(
    `select e.id, e.code, e.party_id, e.amount,
            (current_date - (e.data->>'dueDate')::date) as overdue_days,
            coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), '(unknown)') as customer
     from entities e
     where e.org_id = $1 and e.type = 'invoice'
       and e.status in ('sent','overdue','partial')
       and e.data->>'dueDate' is not null
       and (e.data->>'dueDate')::date < current_date
     order by e.amount desc
     limit 1`,
    [orgId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    invoice: r.code,
    customerId: r.party_id,
    customer: r.customer,
    amount: Number(r.amount),
    overdueDays: Number(r.overdue_days),
  };
}

/** Map one anomaly to a concrete draft action. */
export async function proposeRemediation(orgId: string, a: Anomaly): Promise<RemediationProposal | null> {
  switch (a.kind) {
    case 'receivables_spike': {
      const inv = await resolveWorstOverdue(orgId);
      if (!inv) return null;
      return {
        anomalyKind: a.kind,
        title: a.title,
        actionType: 'send_reminder',
        payload: {
          invoiceId: inv.id,
          invoice: inv.invoice,
          customerId: inv.customerId,
          customer: inv.customer,
          amount: inv.amount,
          days: inv.overdueDays,
          channel: 'whatsapp',
        },
        preview: `Send WhatsApp payment reminder to ${inv.customer} for ${inv.invoice} (₹${inv.amount.toLocaleString('en-IN')}, ${inv.overdueDays}d overdue)`,
        risk: 'external',
        rationale: a.detail,
      };
    }
    case 'duplicate_invoice': {
      // the customer isn't at fault — the right fix is a credit-note draft
      // against the flagged invoice, not a payment chase
      const inv = a.entityId
        ? await query<{ id: string; code: string | null; party_id: string | null; amount: string; customer: string | null }>(
            `select e.id, e.code, e.party_id, e.amount,
                    coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), '(unknown)') as customer
             from entities e where e.org_id = $1 and e.id = $2 limit 1`,
            [orgId, a.entityId]
          )
        : [];
      const invRow = inv[0];
      if (!invRow) return null;
      return {
        anomalyKind: a.kind,
        title: a.title,
        actionType: 'credit_note_draft',
        payload: {
          invoiceId: invRow.id,
          invoice: invRow.code,
          customerId: invRow.party_id ?? undefined,
          customer: invRow.customer,
          amount: Number(invRow.amount),
          reason: 'Possible duplicate billing detected by anomaly scan',
        },
        preview: `Draft credit note ₹${Number(invRow.amount).toLocaleString('en-IN')} against ${invRow.code ?? 'invoice'} for ${invRow.customer} (duplicate check)`,
        risk: 'write',
        rationale: a.detail,
      };
    }
    case 'price_variance': {
      // escalate to the vendor of the flagged document with an RFQ for market rate
      const docRows = a.entityId
        ? await query<{ party_id: string | null; item_id: string | null; vendor: string | null; item: string | null }>(
            `select e.party_id, e.item_id,
                    coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), null) as vendor,
                    coalesce((select coalesce(i.name, i.data->>'name') from entities i where i.id = e.item_id), null) as item
             from entities e where e.org_id = $1 and e.id = $2 limit 1`,
            [orgId, a.entityId]
          )
        : [];
      const d = docRows[0];
      if (!d?.item_id) return null;
      return {
        anomalyKind: a.kind,
        title: a.title,
        actionType: 'send_rfq',
        payload: {
          vendorId: d.party_id ?? undefined,
          vendor: d.vendor ?? 'vendor',
          itemId: d.item_id,
          item: d.item ?? 'item',
          qty: 1,
          uom: 'nos',
          needBy: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        },
        preview: `Send RFQ to ${d.vendor ?? 'vendor'} for ${d.item ?? 'item'} — benchmark the off-median price`,
        risk: 'external',
        rationale: a.detail,
      };
    }
    default:
      return null;
  }
}

export interface ProposalOutcome {
  proposal: RemediationProposal | null;
  decision: 'auto' | 'ask' | 'deny' | 'skipped';
  approvalId?: string;
  reason: string;
}

/** Propose remediations for the worst finding, routed through policy. */
export async function proposeTopRemediation(orgId: string): Promise<ProposalOutcome> {
  const report = await scanAnomalies(orgId);
  const worst = report.anomalies.find((a) => a.severity === 'high') ?? report.anomalies[0];
  if (!worst) return { proposal: null, decision: 'skipped', reason: 'no anomalies to remediate' };

  const proposal = await proposeRemediation(orgId, worst);
  if (!proposal) return { proposal: null, decision: 'skipped', reason: `no draft action for ${worst.kind}` };

  const r = await checkPolicyAndQueue(
    {
      orgId,
      actionType: proposal.actionType,
      entityType: proposal.actionType === 'send_reminder' ? 'invoice' : 'item',
      entityId: (proposal.payload.invoiceId as string) ?? (proposal.payload.itemId as string) ?? null,
      payload: { ...proposal.payload, __remediationOf: worst.kind, __remediationTitle: worst.title },
      preview: `[auto-fix] ${proposal.preview}`,
      risk: proposal.risk,
    },
    (pl) => executeAction(orgId, proposal.actionType, pl as Record<string, unknown>)
  );
  await audit(orgId, 'agent', 'remediation.proposed', {
    metadata: { anomaly: worst.kind, actionType: proposal.actionType, decision: r.decision, approvalId: r.approvalId ?? null },
  });
  return {
    proposal,
    decision: r.decision,
    approvalId: r.approvalId,
    reason: r.reason ?? proposal.rationale,
  };
}

/**
 * Bookkeeping + outcome reporting when an approval created by remediation is
 * decided. Execution happens once via decideApproval's executor — this must
 * NOT re-run the action; it ties the decision back to the finding (audit)
 * and messages the owner's WhatsApp with the outcome (the loop closes where
 * it opened).
 */
export async function decideProposal(
  orgId: string,
  approvalId: string,
  approved: boolean,
  decidedBy: string,
  execResult?: { status?: string; result?: { ok?: boolean; result?: unknown }; error?: string }
): Promise<{ ok: boolean; error?: string }> {
  const rows = await query<{ payload: Record<string, unknown>; action_type: string; preview: string | null }>(
    'select payload, action_type, preview from approvals where org_id = $1 and id = $2 limit 1',
    [orgId, approvalId]
  );
  const appr = rows[0];
  if (!appr) return { ok: false, error: 'approval not found' };
  const payload = typeof appr.payload === 'string' ? (JSON.parse(appr.payload || '{}') as Record<string, unknown>) : (appr.payload ?? {});
  const finding = payload.__remediationOf as string | undefined;
  if (!finding) return { ok: true };

  await audit(orgId, decidedBy, approved ? 'remediation.approved' : 'remediation.rejected', {
    entityId: approvalId,
    metadata: { remediation: true, actionType: appr.action_type, finding },
  });

  const detail = String(payload.__remediationTitle ?? appr.preview ?? finding);
  const executed = approved && execResult?.status === 'executed' && execResult.result?.ok !== false;
  const body = approved
    ? executed
      ? `✅ *Auto-fix executed.* ${detail}\nI've logged everything in the audit trail.`
      : `⚠️ You approved the fix, but execution failed — I've flagged it in the audit trail. ${detail}`
    : `🚫 Fix rejected — I'll leave it on the *Needs attention* list. ${detail}`;
  try {
    const { notifyOwnerDirect } = await import('./notify.js');
    await notifyOwnerDirect(orgId, body, 'remediation_outcome');
  } catch {
    // outcome reporting is best-effort
  }
  return { ok: true };
}
