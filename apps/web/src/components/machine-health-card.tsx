'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ActivityIcon, TriangleAlertIcon } from 'lucide-react';

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
interface Snapshot {
  machines: MachineRow[];
  anomalies7d: Array<{ machine: string; metric: string; value: number; deviationPct: number; at: string }>;
  lastReadingAt: string | null;
}

/**
 * Machine health (Agent 13 P2b): the sensor path made visible in the app —
 * per-machine latest readings against their EWMA baselines, live deviation
 * with the anomaly threshold, and the 7-day anomaly feed. Mirrors what the
 * owner already gets on WhatsApp via telemetry alerts.
 */
export function MachineHealthCard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    fetch('/api/telemetry/machines')
      .then((r) => r.json())
      .then((d) => setSnap(d.ok ? d : null))
      .catch(() => setSnap(null));
  }, []);

  const hasData = !!snap && (snap.machines.length > 0 || snap.anomalies7d.length > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ActivityIcon className="h-4 w-4 text-cyan-600" /> Machine health
        </CardTitle>
        <CardDescription>
          Sensor readings vs each machine&apos;s learned baseline — anomalies reach maintenance instantly on WhatsApp;
          this is the same picture in the app.
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
                        <Badge variant="destructive">{m.anomalyCount7d} alert{m.anomalyCount7d > 1 ? 's' : ''} · 7d</Badge>
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
                  <TriangleAlertIcon className="h-3.5 w-3.5 text-red-500" /> Recent anomalies
                </div>
                <div className="space-y-0.5">
                  {snap.anomalies7d.slice(0, 5).map((a, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px]">
                      <span>
                        <span className="font-medium">{a.machine}</span> {a.metric} {a.value} — {a.deviationPct > 0 ? '+' : ''}
                        {a.deviationPct}% vs baseline
                      </span>
                      <span className="text-muted-foreground">{a.at}</span>
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
