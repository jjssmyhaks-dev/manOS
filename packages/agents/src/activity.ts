import { query, audit } from '@factory/db';

/**
 * F4 — the trust layer: the AI activity log as a product surface.
 * Every agent action lands here with a one-line human summary, the data
 * sources it read, and the reason it acted. Owners can search the timeline,
 * undo executed actions inside the undo window, and leave thumbs up/down
 * that feed the eval set.
 *
 * Copywriting matters: summaries are written like
 *   "Read inward invoice INV-2207 from WhatsApp, matched to PO-3206126,
 *    created draft GRN — awaiting your confirm"
 */

export const UNDO_WINDOW_MINUTES = 24 * 60;

export interface ActionSource {
  type: string; // document | invoice | purchase_order | metric | connector | message
  label: string; // human label, e.g. "Invoice INV-2207 (WhatsApp photo)"
  ref?: string; // entity id or url
}

export interface RecordAgentActionInput {
  orgId: string;
  actor?: string;
  actionType: string;
  summary: string;
  reason?: string;
  sources?: ActionSource[];
  entityType?: string;
  entityId?: string;
  status?: 'draft' | 'awaiting_approval' | 'executed' | 'failed';
  metadata?: Record<string, unknown>;
}

export interface AgentActionRow {
  id: string;
  org_id: string;
  actor: string;
  action_type: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
  reason: string | null;
  sources: ActionSource[];
  status: string;
  executed_at: string | null;
  undone_at: string | null;
  undo_of: string | null;
  feedback: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function recordAgentAction(input: RecordAgentActionInput): Promise<AgentActionRow> {
  const status = input.status ?? 'executed';
  const rows = await query<AgentActionRow>(
    `insert into agent_actions (org_id, actor, action_type, entity_type, entity_id, summary, reason, sources, status, executed_at, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb)
     returning *`,
    [
      input.orgId,
      input.actor ?? 'agent',
      input.actionType,
      input.entityType ?? null,
      input.entityId ?? null,
      input.summary,
      input.reason ?? null,
      JSON.stringify(input.sources ?? []),
      status,
      status === 'executed' ? new Date().toISOString() : null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return rows[0]!;
}

export interface ActivityListOpts {
  search?: string;
  actionType?: string;
  includeUndone?: boolean;
  limit?: number;
}

export async function listActivity(orgId: string, opts: ActivityListOpts = {}): Promise<AgentActionRow[]> {
  const params: unknown[] = [orgId];
  let where = 'org_id = $1';
  if (opts.actionType) {
    params.push(opts.actionType);
    where += ` and action_type = $${params.length}`;
  }
  if (opts.search?.trim()) {
    params.push(`%${opts.search.trim()}%`);
    where += ` and (summary ilike $${params.length} or reason ilike $${params.length} or coalesce(entity_id,'') ilike $${params.length})`;
  }
  params.push(opts.limit ?? 100);
  return query<AgentActionRow>(
    `select * from agent_actions where ${where} order by created_at desc limit $${params.length}`,
    params
  );
}

export function withinUndoWindow(action: Pick<AgentActionRow, 'status' | 'executed_at' | 'undone_at'>, now = Date.now()): boolean {
  if (action.status !== 'executed' || action.undone_at) return false;
  if (!action.executed_at) return false;
  const executed = new Date(action.executed_at).getTime();
  return now - executed <= UNDO_WINDOW_MINUTES * 60_000;
}

export interface UndoResult {
  ok: boolean;
  error?: string;
  compensations?: string[];
}

/**
 * Undo an executed action inside the window: marks the row undone and runs
 * the compensating write where one exists (note drafts become status
 * 'cancelled' — never deletions, so the audit trail stays complete).
 */
export async function undoAgentAction(orgId: string, actionId: string, undoneBy: string): Promise<UndoResult> {
  const rows = await query<AgentActionRow>('select * from agent_actions where org_id = $1 and id = $2 limit 1', [orgId, actionId]);
  const action = rows[0];
  if (!action) return { ok: false, error: 'Activity entry not found' };
  if (!withinUndoWindow(action)) {
    return { ok: false, error: 'Outside the undo window (24 hours) or already undone' };
  }

  const compensations: string[] = [];
  const meta = (action.metadata ?? {}) as { undo?: { kind?: string; entityType?: string; entityId?: string } };
  const undoInfo = meta.undo ?? {};
  if (undoInfo.kind === 'created_record' && undoInfo.entityType && undoInfo.entityId) {
    await query(`update entities set status = 'cancelled' where org_id = $1 and id = $2 and status not in ('paid','closed','posted_to_tally','posted')`, [orgId, undoInfo.entityId]);
    compensations.push(`The ${undoInfo.entityType.replace(/_/g, ' ')} the agent created is now cancelled (nothing was deleted — the audit trail is intact).`);
  } else {
    compensations.push('This was an outbound message — it could not be recalled, but it is marked undone here and excluded from reports.');
  }

  await query(`update agent_actions set status = 'undone', undone_at = now() where org_id = $1 and id = $2`, [orgId, actionId]);
  await audit(orgId, undoneBy, 'activity.undone', {
    entityType: action.action_type,
    entityId: action.id,
    metadata: { originalSummary: action.summary, compensations },
  });
  return { ok: true, compensations };
}

/** Thumbs up/down on an activity entry — feeds the eval set. */
export async function setActionFeedback(orgId: string, actionId: string, feedback: 'up' | 'down'): Promise<void> {
  await query('update agent_actions set feedback = $3 where org_id = $1 and id = $2', [orgId, actionId, feedback]);
}

export function undoWindowText(action: Pick<AgentActionRow, 'status' | 'executed_at' | 'undone_at'>): string | null {
  if (!withinUndoWindow(action)) return null;
  const executed = new Date(action.executed_at!).getTime();
  const minsLeft = Math.max(0, Math.round((executed + UNDO_WINDOW_MINUTES * 60_000 - Date.now()) / 60_000));
  return minsLeft > 60 ? `can undo for ${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m` : `can undo for ${minsLeft} min`;
}

export { UNDO_WINDOW_MINUTES as UNDO_WINDOW };
