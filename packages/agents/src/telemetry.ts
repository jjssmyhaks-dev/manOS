import { query, audit } from '@factory/db';

/**
 * Agent 13 P2b — the sensor path (spec): the edge gateway posts readings to
 * /api/ingest/machine; detectAnomaly flags deviations (vibration,
 * temperature, current…) against the machine's per-metric baseline by the
 * configured threshold %, and createMaintenanceAlert lands in the
 * maintenance team's queue with HIGHER urgency than routine PM — the alert
 * records on the activity timeline and queues an owner notification.
 *
 * Baselines: seeded from the machine master (data.baselines) when a machine
 * is first seen; every healthy reading also nudges the baseline (EWMA) so
 * the model tracks real machine behaviour instead of going stale. Anomalous
 * readings never move the baseline.
 */

export type TelemetryMetric = 'vibration' | 'temperature' | 'run_hours' | 'current' | 'pressure';

export const METRIC_UNITS: Record<string, string> = {
  vibration: 'mm/s',
  temperature: '°C',
  run_hours: 'h',
  current: 'A',
  pressure: 'bar',
};

export interface TelemetryReading {
  machineCode: string;
  metric: TelemetryMetric;
  value: number;
  unit?: string;
  recordedAt?: string;
}

export interface Baseline {
  baseline: number;
  thresholdPct: number;
}

export interface AnomalyVerdict {
  anomalous: boolean;
  deviationPct: number;
  baseline: number;
  thresholdPct: number;
  detail: string;
}

/** Baseline for a machine+metric; falls back to the machine master, else null. */
export async function getBaseline(orgId: string, machineCode: string, metric: string): Promise<Baseline | null> {
  const rows = await query<{ baseline: string; threshold_pct: string }>(
    `select baseline, threshold_pct from telemetry_baselines where org_id=$1 and machine_code=$2 and metric=$3`,
    [orgId, machineCode, metric]
  );
  if (rows[0]) return { baseline: Number(rows[0].baseline), thresholdPct: Number(rows[0].threshold_pct) };

  // first sighting: adopt the machine master's declared baseline (if any)
  const master = await query<{ data: Record<string, unknown> }>(
    `select data from entities where org_id=$1 and type='machine' and (code=$2 or name=$2) limit 1`,
    [orgId, machineCode]
  );
  const baselines = (master[0]?.data?.baselines ?? {}) as Record<string, number>;
  const declared = baselines[metric];
  if (typeof declared === 'number' && declared > 0) {
    await upsertBaseline(orgId, machineCode, metric, declared, 25);
    return { baseline: declared, thresholdPct: 25 };
  }
  return null;
}

export async function upsertBaseline(orgId: string, machineCode: string, metric: string, baseline: number, thresholdPct: number): Promise<void> {
  await query(
    `insert into telemetry_baselines (org_id, machine_code, metric, baseline, threshold_pct)
     values ($1,$2,$3,$4,$5)
     on conflict (org_id, machine_code, metric) do update set baseline = excluded.baseline, threshold_pct = excluded.threshold_pct, updated_at = now()`,
    [orgId, machineCode, metric, baseline, thresholdPct]
  );
  // baseline changes shape every future anomaly verdict — they are audited
  await audit(orgId, 'system', 'telemetry.baseline_upsert', {
    metadata: { machine: machineCode, metric, baseline, thresholdPct },
  });
}

/** Spec detectAnomaly: deviation vs the machine's baseline, % based. */
export function detectAnomaly(value: number, b: Baseline): AnomalyVerdict {
  const deviationPct = b.baseline === 0 ? 0 : Math.round(((value - b.baseline) / b.baseline) * 1000) / 10;
  const anomalous = Math.abs(deviationPct) > b.thresholdPct;
  return {
    anomalous,
    deviationPct,
    baseline: b.baseline,
    thresholdPct: b.thresholdPct,
    detail: anomalous
      ? `${deviationPct > 0 ? 'Above' : 'Below'} baseline ${b.baseline} by ${Math.abs(deviationPct)}% (threshold ${b.thresholdPct}%)`
      : `Within ${b.thresholdPct}% of baseline ${b.baseline}`,
  };
}

export interface IngestResult {
  ok: boolean;
  anomaly?: AnomalyVerdict & { metric: string; value: number; machineCode: string };
  baselineMissing?: boolean;
  error?: string;
}

/** Ingest one reading: store → detect → alert. Never throws for bad rows. */
export async function ingestReading(orgId: string, reading: TelemetryReading): Promise<IngestResult> {
  if (!(reading.value > 0) || !reading.machineCode || !reading.metric) {
    return { ok: false, error: 'machineCode, metric and a positive value are required' };
  }
  await query(
    `insert into machine_telemetry (org_id, machine_code, metric, value, unit)
     values ($1,$2,$3,$4,$5)`,
    [orgId, reading.machineCode, reading.metric, reading.value, reading.unit ?? METRIC_UNITS[reading.metric] ?? null]
  );

  const b = await getBaseline(orgId, reading.machineCode, reading.metric);
  if (!b) {
    await audit(orgId, 'system', 'telemetry.no_baseline', {
      metadata: { machine: reading.machineCode, metric: reading.metric, value: reading.value },
    });
    return { ok: true, baselineMissing: true };
  }

  const verdict = detectAnomaly(reading.value, b);
  if (!verdict.anomalous) {
    // healthy reading → EWMA nudge (α = 0.1) so the baseline tracks reality;
    // anomalous readings never move it. Inlined (not per-reading audited) to
    // keep the audit log free of one row per sensor ping.
    await query(
      `update telemetry_baselines set baseline = baseline * 0.9 + $4 * 0.1, updated_at = now()
       where org_id=$1 and machine_code=$2 and metric=$3`,
      [orgId, reading.machineCode, reading.metric, reading.value]
    );
    return { ok: true };
  }

  // anomaly: alert with higher urgency than routine PM
  const unit = reading.unit ?? METRIC_UNITS[reading.metric] ?? '';
  await createMaintenanceAlert(orgId, {
    machineCode: reading.machineCode,
    metric: reading.metric,
    value: reading.value,
    unit,
    verdict,
  });
  return { ok: true, anomaly: { ...verdict, metric: reading.metric, value: reading.value, machineCode: reading.machineCode } };
}

export interface MaintenanceAlertResult {
  activityId?: string;
  queuedNotification: boolean;
}

/** Sensor alert → activity timeline + urgent owner notification. */
export async function createMaintenanceAlert(
  orgId: string,
  a: { machineCode: string; metric: string; value: number; unit: string; verdict: AnomalyVerdict }
): Promise<MaintenanceAlertResult> {
  const { recordAgentAction } = await import('./activity.js');
  const action = await recordAgentAction({
    orgId,
    actor: 'gateway',
    actionType: 'telemetry_anomaly',
    summary: `⚠️ ${a.machineCode}: ${a.metric} ${a.value}${a.unit} — ${a.verdict.detail}`,
    reason: `Sensor reading deviates from the machine baseline; routed to maintenance at higher urgency than routine PM`,
    sources: [{ type: 'machine', label: `Machine ${a.machineCode} (${a.metric} sensor)` }],
    entityType: 'machine',
    metadata: { machine: a.machineCode, metric: a.metric, value: a.value, deviationPct: a.verdict.deviationPct, baseline: a.verdict.baseline },
    status: 'executed',
  });
  await audit(orgId, 'gateway', 'telemetry.anomaly', {
    metadata: { machine: a.machineCode, metric: a.metric, value: a.value, deviationPct: a.verdict.deviationPct },
  });
  let queuedNotification = false;
  try {
    await query(
      `insert into notifications (org_id, channel, to_addr, template, body, status) values ($1,'whatsapp','owner','telemetry_alert',$2,'queued')`,
      [orgId, `🚨 *${a.machineCode}: ${a.metric} anomaly*\n${a.value}${a.unit} vs baseline ${a.verdict.baseline} (${a.verdict.deviationPct > 0 ? '+' : ''}${a.verdict.deviationPct}%). Check the machine before the next shift.`]
    );
    queuedNotification = true;
  } catch {
    // notification queue must never break ingestion
  }
  return { activityId: action.id, queuedNotification };
}

/** Durable per-machine anomaly history (dashboard/read tools). */
export async function recentAnomalies(orgId: string, machineCode?: string, limit = 20): Promise<Array<{ machine: string; metric: string; value: number; deviationPct: number; at: string }>> {
  const rows = await query<{ machine: string; metric: string; value: string; deviation: string; at: string }>(
    `select metadata->>'machine' as machine, metadata->>'metric' as metric, (metadata->>'value')::text as value,
            (metadata->>'deviationPct')::text as deviation, created_at::text as at
     from agent_actions
     where org_id=$1 and action_type='telemetry_anomaly' and ($2::text is null or metadata->>'machine' = $2)
     order by created_at desc limit $3`,
    [orgId, machineCode ?? null, limit]
  );
  return rows.map((r) => ({ machine: r.machine, metric: r.metric, value: Number(r.value), deviationPct: Number(r.deviation ?? 0), at: r.at }));
}
