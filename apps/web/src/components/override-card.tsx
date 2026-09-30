'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheckIcon } from 'lucide-react';

interface WeekOverride {
  weekStart: string;
  executed: number;
  overridden: number;
  overrideRatePct: number;
}

interface Report {
  weeks: WeekOverride[];
  trend: string;
  verdict: string;
}

/** Override-rate card (PRD v2 §8): the trust metric, baselined weekly. */
export function OverrideCard() {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    fetch('/api/override-rate').then((r) => r.json()).then(setReport).catch(() => {});
  }, []);

  const maxRate = Math.max(10, ...(report?.weeks ?? []).map((w) => w.overrideRatePct));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Trust meter</CardTitle>
          <CardDescription>How often the owner overrides the AI, week by week — the pilot exit metric</CardDescription>
        </div>
        {report && report.trend !== 'no-baseline' && (
          <Badge variant={report.trend === 'worsening' ? 'warning' : 'success'}>{report.trend}</Badge>
        )}
      </CardHeader>
      <CardContent>
        {!report ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              {report.weeks.map((w) => (
                <div key={w.weekStart} className="flex flex-1 flex-col items-center gap-1" title={`week of ${w.weekStart}: ${w.executed} executed, ${w.overridden} overridden (${w.overrideRatePct}%)`}>
                  <span className="text-[10px] text-muted-foreground">{w.executed + w.overridden > 0 ? `${w.overrideRatePct}%` : '–'}</span>
                  <div className="w-full rounded-t bg-primary/70" style={{ height: `${Math.max(3, (w.overrideRatePct / maxRate) * 48)}px` }} />
                  <span className="text-[9px] text-muted-foreground">{w.weekStart.slice(5)}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{report.verdict}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export { ShieldCheckIcon };
