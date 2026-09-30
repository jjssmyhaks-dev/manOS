'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { SparklesIcon } from 'lucide-react';

interface Anomaly {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  metric: number;
}

/**
 * "Needs attention" (PRD §9): proactive anomaly findings — price variances,
 * possible duplicate invoices, receivables spikes. The agent explains each on
 * click; findings also flow into the daily WhatsApp digest + urgent alerts.
 */
export function AnomaliesCard() {
  const [items, setItems] = useState<Anomaly[] | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/anomalies').then((r) => r.json()).then((d) => setItems(d.anomalies ?? []));
  }, []);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Needs attention</CardTitle>
          <CardDescription>Automatic scans: price variance, duplicates, receivables spikes</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {items && <Badge variant={items.length ? 'warning' : 'success'}>{items.length} finding{items.length === 1 ? '' : 's'}</Badge>}
          <Button variant="ghost" size="sm" onClick={() => router.push('/?explain=anomalies')}>
            <SparklesIcon className="mr-1 h-3.5 w-3.5" /> Explain
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {items === null ? (
          <p className="text-sm text-muted-foreground">Scanning…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">All clear — no anomalies detected.</p>
        ) : (
          <div className="space-y-2">
            {items.map((a, i) => (
              <button
                key={i}
                onClick={() => router.push(`/?explain=${encodeURIComponent(a.kind)}`)}
                className="flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-xs hover:bg-muted/50"
              >
                <span className={a.severity === 'high' ? 'text-destructive' : 'text-amber-600'}>{a.severity === 'high' ? '●' : '●'}</span>
                <span>
                  <span className="font-medium">{a.title}</span>
                  <span className="block text-muted-foreground">{a.detail}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
