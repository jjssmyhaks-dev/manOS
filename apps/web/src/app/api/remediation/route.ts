import { getSession } from '@/lib/session';
import { checkPolicyAndQueue } from '@factory/core';
import { scanAnomalies, proposeRemediation, executeAction, type Anomaly } from '@factory/agents';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/remediation — for each anomaly the agent found, the draft action
 * it *would* take (pure preview — nothing queued, nothing sent). The
 * dashboard "Needs attention" card renders these as one-click "Propose fix"
 * buttons that queue the real action through the policy engine.
 */

export async function GET() {
  const s = await getSession();
  const report = await scanAnomalies(s.orgId);
  const proposals = await Promise.all(
    report.anomalies.map(async (a: Anomaly) => {
      const p = await proposeRemediation(s.orgId, a);
      return {
        kind: a.kind,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        actionType: p?.actionType ?? null,
        preview: p?.preview ?? null,
        rationale: p?.rationale ?? a.detail,
      };
    })
  );
  return Response.json({ asOf: report.asOf, proposals });
}

/**
 * POST /api/remediation {kind} — actually propose the fix for one finding:
 * drafts the action and routes it through the policy engine (auto executes,
 * ask queues an approval in the inbox, deny refuses).
 */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as { kind?: string };
  if (!body.kind) return Response.json({ error: 'kind required' }, { status: 400 });

  const report = await scanAnomalies(s.orgId);
  const anomaly = report.anomalies.find((a: Anomaly) => a.kind === body.kind);
  if (!anomaly) return Response.json({ error: `no ${body.kind} finding right now` }, { status: 404 });

  const proposal = await proposeRemediation(s.orgId, anomaly);
  if (!proposal) return Response.json({ error: `no draft action available for ${anomaly.kind}` }, { status: 400 });

  const r = await checkPolicyAndQueue(
    {
      orgId: s.orgId,
      actionType: proposal.actionType,
      entityType: proposal.actionType === 'send_reminder' ? 'invoice' : 'item',
      entityId: (proposal.payload.invoiceId as string) ?? (proposal.payload.itemId as string) ?? null,
      payload: { ...proposal.payload, __remediationOf: anomaly.kind, __remediationTitle: anomaly.title },
      preview: `[auto-fix] ${proposal.preview}`,
      risk: proposal.risk,
    },
    (pl) => executeAction(s.orgId, proposal.actionType, pl as Record<string, unknown>)
  );
  return Response.json({ ok: true, decision: r.decision, approvalId: r.approvalId, reason: r.reason, preview: proposal.preview });
}
