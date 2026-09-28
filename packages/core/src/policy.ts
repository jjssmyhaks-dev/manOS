import { z } from 'zod';
import { query, audit, traceRun } from '@factory/db';
import { policyDefaults } from './packs.js';

/**
 * Harness layer — approval policy engine (PRD §6, F7).
 * Every agent action that writes or goes external passes through here.
 * Per org + action type: auto | ask | deny. Outbound defaults to ask.
 */

export const PolicyDecisionSchema = z.enum(['auto', 'ask', 'deny']);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface PolicyCheckResult {
  decision: PolicyDecision;
  approvalId?: string;
  reason: string;
}

/** Look up the org's decision for an action type, falling back to defaults. */
export async function getPolicyDecision(orgId: string, actionType: string): Promise<PolicyDecision> {
  const rows = await query<{ decision: PolicyDecision }>(
    'select decision from policies where org_id = $1 and action_type = $2 limit 1',
    [orgId, actionType]
  );
  if (rows[0]) return rows[0].decision;
  return (policyDefaults()[actionType]?.decision ?? 'ask') as PolicyDecision;
}

export async function setPolicy(orgId: string, actionType: string, decision: PolicyDecision): Promise<void> {
  await query(
    `insert into policies (org_id, action_type, decision) values ($1,$2,$3)
     on conflict (org_id, action_type) do update set decision = excluded.decision, updated_at = now()`,
    [orgId, actionType, decision]
  );
}

/** Create a pending approval item in the inbox. */
export async function requestApproval(input: {
  orgId: string;
  actionType: string;
  entityType?: string;
  entityId?: string;
  payload: unknown;
  preview: string;
  risk?: 'write' | 'external';
  requestedBy?: string;
}): Promise<string> {
  const rows = await query<{ id: string }>(
    `insert into approvals (org_id, action_type, entity_type, entity_id, payload, preview, risk, requested_by, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'pending') returning id`,
    [
      input.orgId, input.actionType, input.entityType ?? null, input.entityId ?? null,
      JSON.stringify(input.payload), input.preview, input.risk ?? 'write', input.requestedBy ?? 'agent',
    ]
  );
  await audit(input.orgId, 'agent', 'approval.requested', {
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: { actionType: input.actionType, preview: input.preview },
  });
  return rows[0]!.id;
}

/**
 * Evaluate an action against policy. `auto` executes via the handler,
 * `ask` queues an approval and returns, `deny` refuses outright.
 */
export async function checkPolicyAndQueue(
  input: {
    orgId: string;
    actionType: string;
    entityType?: string;
    entityId?: string;
    payload: unknown;
    preview: string;
    risk?: 'write' | 'external';
  },
  execute: (payload: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>
): Promise<PolicyCheckResult> {
  const decision = await getPolicyDecision(input.orgId, input.actionType);

  if (decision === 'deny') {
    await audit(input.orgId, 'policy', 'action.denied', {
      entityType: input.entityType, entityId: input.entityId, metadata: { actionType: input.actionType },
    });
    return { decision, reason: `Action '${input.actionType}' is denied by policy for this organisation.` };
  }

  if (decision === 'ask') {
    const approvalId = await requestApproval(input);
    return { decision, approvalId, reason: 'Queued for human approval in the approvals inbox.' };
  }

  // auto
  const result = await execute(input.payload);
  await audit(input.orgId, 'agent', `action.executed:${input.actionType}`, {
    entityType: input.entityType, entityId: input.entityId, after: result.result,
  });
  return { decision, reason: 'Executed automatically per policy.' };
}

/** Called by the approvals API when a human decides. */
export async function decideApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  decidedBy: string,
  execute: (payload: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>
): Promise<{ status: string; result?: unknown; error?: string }> {
  const rows = await query<{ id: string; org_id: string; action_type: string; payload: string; status: string }>(
    'select id, org_id, action_type, payload, status from approvals where id = $1 limit 1',
    [approvalId]
  );
  const appr = rows[0];
  if (!appr) throw new Error(`Approval ${approvalId} not found`);
  if (appr.status !== 'pending') return { status: appr.status, result: appr.payload };

  if (decision === 'reject') {
    await query(`update approvals set status='rejected', decided_by=$2, decided_at=now() where id=$1`, [approvalId, decidedBy]);
    await audit(appr.org_id, decidedBy, 'approval.rejected', { entityId: approvalId, metadata: { actionType: appr.action_type } });
    return { status: 'rejected' };
  }

  // PGlite parses jsonb columns to JS objects already; tolerate raw strings too
  const payload = typeof appr.payload === 'string' ? (JSON.parse(appr.payload) as unknown) : (appr.payload as unknown);
  let result: { ok: boolean; result?: unknown; error?: string };
  try {
    result = await execute(payload);
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const status = result.ok ? 'executed' : 'failed';
  await query(`update approvals set status=$2, decided_by=$3, decided_at=now(), result=$4 where id=$1`, [
    approvalId, status, decidedBy, JSON.stringify(result),
  ]);
  await audit(appr.org_id, decidedBy, `approval.${status}`, {
    entityId: approvalId, metadata: { actionType: appr.action_type, error: result.error },
  });
  return { status, result: result.result, error: result.error };
}

/** Minimal in-proc executor registry used by the web app. */
export type Executor = (payload: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
const executors = new Map<string, Executor>();
export function registerExecutor(actionType: string, fn: Executor): void {
  executors.set(actionType, fn);
}
export function getExecutor(actionType: string): Executor | undefined {
  return executors.get(actionType);
}
