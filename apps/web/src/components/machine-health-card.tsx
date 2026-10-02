'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ActivityIcon, TriangleAlertIcon, CheckIcon, WrenchIcon } from 'lucide-react';

interface MetricRow {
  metric: string;
  lastValue: number | null;
  unit: string | null;
  lastAt: string | null;
  baseline: number | null;
  thresholdPct: number | null;
  deviationPct: number | null;
  anomalous: boolean;
}
interface MachineRow {
  machineCode: string;
  metrics: MetricRow[];
  anomalyCount7d: number;
  lastAnomalyAt: string | null;
}
interface AnomalyRow {
  id: string;
  machine: string;
  metric: string;
  value: number;
  deviationPct: number;
  at: string;
  status: 'open' | 'acked' | 'resolved';
}
interface Snapshot {
  machines: MachineRow[];
  anomalies7d: AnomalyRow[];
  lastReadingAt: string | null;
}

/**
 * Machine health (Agent 13 P2b): the sensor path made visible in the app —
 * per-machine latest readings against their EWMA baselines, live deviation
 * with the anomaly threshold, and the anomaly feed with lifecycle: open →
 * acked (maintenance has eyes on it) → resolved (closed). Every ack/resolve
 * goes through the audit trail, like every agent action.
 */
export function MachineHealthCard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () =>
    fetch('/api/telemetry/machines')
      .then((r) => r.json())
      .then((d) => setSnap(d.ok ? d : null))
      .catch(() => setSnap(null));

  useEffect(() => {
    load();
  }, []);

  const setAlert = async (alertId: string, status: 'acked' | 'resolved') => {
    setBusyId(alertId);
    try {
      await fetch('/api/telemetry/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alertId, status }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const statusBadge = (s: AnomalyRow['status']) =>
    s === 'resolved' ? (
      <Badge variant="success"><CheckIcon className="mr-1 h-3 w-3" />resolved</Badge>
    ) : s === 'acked' ? (
      <Badge variant="secondary">acked</Badge>
    ) : (
      <Badge variant="destructive">open</Badge>
    );

  const hasData = !!snap && (snap.machines.length > 0 || snap.anomalies7d.length > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ActivityIcon className="h-4 w-4 text-cyan-600" /> Machine health
        </CardTitle>
        <CardDescription>
          Sensor readings vs each machine&apos;s learned baseline — anomalies reach maintenance instantly on WhatsApp;
          ack and resolve them here (every action is audit-trailed).
          {snap?.lastReadingAt ? <span className="ml-1 opacity-70">Last reading {snap.lastReadingAt}.</span> : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!snap ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : !hasData ? (
          <p className="text-xs text-muted-foreground">
            No telemetry yet — the edge gateway hasn&apos;t posted readings. Wire it up (docs/gateway.md) and this card
            fills in within seconds; machines with declared baselines start alerting on the first anomalous reading.
          </p>
        ) : (
          <>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {snap.machines.map((m) => {
                const anyAnomalous = m.metrics.some((x) => x.anomalous);
                return (
                  <div key={m.machineCode} className={`rounded-md border px-3 py-2 ${anyAnomalous ? 'border-red-300 bg-red-50/50' : ''}`}>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-semibold">{m.machineCode}</span>
                      {m.anomalyCount7d > 0 ? (
                        <Badge variant="destructive">{m.anomalyCount7d} open</Badge>
                      ) : (
                        <Badge variant="success">healthy</Badge>
                      )}
                    </div>
                    {m.metrics.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">No readings yet</p>
                    ) : (
                      <div className="space-y-0.5">
                        {m.metrics.map((x) => (
                          <div key={x.metric} className="flex items-center justify-between text-[11px]">
                            <span className="text-muted-foreground">{x.metric}</span>
                            <span className={x.anomalous ? 'font-semibold text-red-600' : ''}>
                              {x.lastValue !== null ? `${x.lastValue}${x.unit ?? ''}` : 'no data'}
                              {x.deviationPct !== null ? (
                                <span className={x.anomalous ? '' : ' text-muted-foreground'}>
                                  {' '}({x.deviationPct > 0 ? '+' : ''}
                                  {x.deviationPct}%{x.anomalous ? ' ⚠' : ''})
                                </span>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {snap.anomalies7d.length > 0 && (
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <TriangleAlertIcon className="h-3.5 w-3.5 text-red-500" /> Anomaly alerts — ack to claim, resolve to close
                </div>
                <div className="space-y-1.5">
                  {snap.anomalies7d.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-2">
                      <div className="min-w-0 text-[11px]">
                        <span className="font-medium">{a.machine}</span> {a.metric} {a.value} — {a.deviationPct > 0 ? '+' : ''}
                        {a.deviationPct}% vs baseline <span className="text-muted-foreground">· {a.at}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {statusBadge(a.status)}
                        {a.status === 'open' && (
                          <button
                            onClick={() => setAlert(a.id, 'acked')}
                            disabled={busyId === a.id}
                            className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
                          >
                            Ack
                          </button>
                        )}
                        {a.status !== 'resolved' && (
                          <button
                            onClick={() => setAlert(a.id, 'resolved')}
                            disabled={busyId === a.id}
                            className="inline-flex items-center gap-0.5 rounded border border-emerald-300 px-1.5 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                          >
                            <WrenchIcon className="h-3 w-3" /> Resolve
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
