import { query } from '@factory/db';

/**
 * Connector liveness monitoring (PRD F1 connector health + PRD C-4 desktop
 * agent contract): a Tally connector that has stopped heartbeating is a silent
 * failure — pushes queue up and masters go stale while the dashboard still
 * looks green. The monitor re-derives health from the connectors table and
 * flags:
 *   - error rows  (desktop agent reported a failure on its last heartbeat)
 *   - stale rows  (active connector with no heartbeat inside STALE_AFTER_MIN)
 *   - failed pushes (approvals stuck in executed state without result.pushed —
 *     served by heartbeat but never acked by the connector)
 * Dormant rows (never registered/connected) are reported but never alarms.
 */

/** A connector is stale when its last successful sync is older than this. */
export const STALE_AFTER_MIN = 60;

export interface ConnectorHealth {
  type: string;
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
  minutesSinceSync: number | null;
  /** error | stale | ok | dormant */
  health: 'ok' | 'error' | 'stale' | 'dormant';
  /** approved tally_push still awaiting a connector ack */
  pendingPushes: number;
}

export interface ConnectorHealthReport {
  checkedAt: string;
  staleAfterMin: number;
  connectors: ConnectorHealth[];
  failures: Array<{ type: string; issue: string; detail: string }>;
  ok: boolean;
}

export async function connectorHealth(orgId: string, staleAfterMin = STALE_AFTER_MIN): Promise<ConnectorHealthReport> {
  const rows = await query<{
    type: string;
    status: string;
    last_sync_at: Date | string | null;
    last_error: string | null;
  }>(
    `select type, status, last_sync_at, last_error from connectors where org_id = $1 order by type`,
    [orgId]
  );

  const pushCounts = await query<{ org_id: string; c: string }>(
    `select org_id, count(*) as c from approvals
     where org_id = $1 and action_type = 'tally_push' and status = 'executed' and result->>'pushed' is null
     group by org_id`,
    [orgId]
  );
  const pendingPushes = Number(pushCounts[0]?.c ?? 0);

  const connectors: ConnectorHealth[] = rows.map((r) => {
    const lastSyncAt = r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null;
    const minutesSinceSync = lastSyncAt
      ? Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 60_000)
      : null;
    const active = ['registered', 'connected', 'syncing'].includes(r.status);
    let health: ConnectorHealth['health'] = 'dormant';
    if (r.status === 'error') health = 'error';
    else if (active && (minutesSinceSync === null || minutesSinceSync > staleAfterMin)) health = 'stale';
    else if (active) health = 'ok';
    return {
      type: r.type,
      status: r.status,
      lastSyncAt,
      lastError: r.last_error,
      minutesSinceSync,
      health,
      pendingPushes: r.type === 'tally' ? pendingPushes : 0,
    };
  });

  const failures: ConnectorHealthReport['failures'] = [];
  for (const c of connectors) {
    if (c.health === 'error') {
      failures.push({ type: c.type, issue: 'heartbeat error', detail: c.lastError ?? 'connector reported error status' });
    }
    if (c.health === 'stale') {
      failures.push({
        type: c.type,
        issue: 'no heartbeat',
        detail: c.minutesSinceSync === null
          ? 'active but has never completed a sync'
          : `last sync ${c.minutesSinceSync} min ago (threshold ${staleAfterMin} min)`,
      });
    }
    if (c.type === 'tally' && c.pendingPushes > 0 && c.health !== 'stale' && c.health !== 'error') {
      // pushes backing up while the connector looks healthy is still a warning
      failures.push({ type: c.type, issue: 'push backlog', detail: `${c.pendingPushes} approved push(es) awaiting Tally ack` });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    staleAfterMin,
    connectors,
    failures,
    ok: failures.length === 0,
  };
}
