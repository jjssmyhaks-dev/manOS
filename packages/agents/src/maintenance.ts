import { query } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { executeAction } from './tools/write.js';

/**
 * Agent 13 — Maintenance (P2a, logbook-based per spec): machines carry
 * lastPmDate + pmIntervalDays; anything due within the warning window gets a
 * work-order DRAFT through the policy engine (routine PM may be auto for
 * low-risk orgs — the policy decides per org). Run-hour telemetry (P2b) is a
 * later milestone; where it is missing the record says basis='calendar'
 * EXPLICITLY, per the spec's edge case. Machines without any interval on
 * file are listed as needing one rather than guessed.
 */

export const PM_WARNING_WINDOW_DAYS = 14;

export interface DueMaintenance {
  machineId: string;
  machine: string;
  code: string | null;
  lastPmDate: string | null;
  pmIntervalDays: number;
  dueOn: string;
  daysOverdue: number;
  withinWindow: boolean;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function checkDueMaintenance(
  orgId: string,
  warningWindowDays = PM_WARNING_WINDOW_DAYS
): Promise<{ due: DueMaintenance[]; missingInterval: string[]; total: number }> {
  const machines = await query<{
    id: string;
    code: string | null;
    name: string | null;
    last_pm: string | null;
    interval: string | null;
  }>(
    `select id, code, coalesce(name, data->>'name') as name,
            coalesce(data->>'lastPmDate', to_char(created_at, 'YYYY-MM-DD')) as last_pm,
            data->>'pmIntervalDays' as interval
     from entities where org_id=$1 and type='machine'`,
    [orgId]
  );

  const due: DueMaintenance[] = [];
  const missingInterval: string[] = [];
  for (const m of machines) {
    const interval = m.interval ? Number(m.interval) : null;
    if (!m.last_pm || !interval || interval <= 0) {
      missingInterval.push(m.name ?? m.code ?? m.id);
      continue;
    }
    const dueOn = addDays(m.last_pm, interval);
    const daysOverdue = Math.floor((Date.now() - new Date(dueOn + 'T00:00:00Z').getTime()) / 86_400_000);
    if (daysOverdue >= -warningWindowDays) {
      due.push({
        machineId: m.id,
        machine: m.name ?? m.code ?? m.id,
        code: m.code,
        lastPmDate: m.last_pm,
        pmIntervalDays: interval,
        dueOn,
        daysOverdue,
        withinWindow: daysOverdue <= 0,
      });
    }
  }
  return { due: due.sort((a, b) => b.daysOverdue - a.daysOverdue), missingInterval, total: machines.length };
}

export interface MaintenanceDraftResult {
  drafts: Array<{ machine: string; task: string; dueOn: string; decision: string; approvalId?: string }>;
  missingInterval: string[];
}

/** Draft work orders for everything due; batched one policy call per machine. */
export async function draftMaintenanceWorkOrders(orgId: string): Promise<MaintenanceDraftResult> {
  const { due, missingInterval } = await checkDueMaintenance(orgId);
  const drafts: MaintenanceDraftResult['drafts'] = [];

  for (const d of due) {
    const task = `Preventive maintenance (${d.pmIntervalDays}-day interval${d.daysOverdue > 0 ? `, ${d.daysOverdue} day${d.daysOverdue > 1 ? 's' : ''} overdue` : ', due soon'})`;
    const payload = {
      machineId: d.machineId,
      machine: d.machine,
      machineCode: d.code,
      task,
      dueOn: d.dueOn,
      lastPmDate: d.lastPmDate,
      basis: 'calendar', // explicit per spec: no run-hours without sensors
    };
    const r = await checkPolicyAndQueue(
      {
        orgId,
        actionType: 'create_maintenance_wo',
        entityType: 'machine',
        entityId: d.machineId,
        payload,
        preview: `Maintenance WO: PM on ${d.machine} — ${d.daysOverdue > 0 ? `${d.daysOverdue}d overdue` : `due ${d.dueOn}`}`,
        risk: 'write',
      },
      (pl) => executeAction(orgId, 'create_maintenance_wo', pl as Record<string, unknown>)
    );
    drafts.push({ machine: d.machine, task, dueOn: d.dueOn, decision: r.decision, approvalId: r.approvalId });
  }
  return { drafts, missingInterval };
}

/** Executor for 'create_maintenance_wo' (wired into executeAction). */
export async function executeCreateMaintenanceWo(
  orgId: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const p = payload as { machineId?: string; machine?: string; machineCode?: string; task?: string; dueOn?: string; lastPmDate?: string; basis?: string };
  const rows = await query<{ id: string; code: string | null }>(
    `insert into entities (id, org_id, type, status, code, item_id, date, source, data)
     values (gen_random_uuid()::text, $1, 'work_order', 'open', 'WO-' || to_char(now(),'YYMMDDHH24MISS'), $2, $3::date, 'agent', $4::jsonb)
     returning id, code`,
    [
      orgId,
      p.machineId ?? null,
      p.dueOn ?? new Date().toISOString().slice(0, 10),
      JSON.stringify({
        machine: p.machine ?? p.machineCode ?? 'machine',
        task: p.task ?? 'Preventive maintenance',
        dueOn: p.dueOn ?? null,
        lastPmDate: p.lastPmDate ?? null,
        basis: p.basis ?? 'calendar',
        createdAt: new Date().toISOString(),
      }),
    ]
  );
  return { ok: true, result: { workOrderId: rows[0]!.id, workOrderCode: rows[0]!.code } };
}
