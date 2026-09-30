'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { SparklesIcon, WrenchIcon } from 'lucide-react';

interface Anomaly {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  metric: number;
}

interface Proposal {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  actionType: string | null;
  preview: string | null;
  rationale: string;
}

interface ProposeResult {
  ok?: boolean;
  decision?: string;
  approvalId?: string;
  reason?: string;
  error?: string;
}

/**
 * "Needs attention" (PRD §9): proactive anomaly findings — price variances,
 * possible duplicate invoices, receivables spikes — each with the agent's
 * proposed fix. "Explain" asks the agent in chat; "Propose fix" queues the
 * concrete action through the approval policy engine (closed loop).
 */
export function AnomaliesCard() {
  const [items, setItems] = useState<Anomaly[] | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ProposeResult>>({});
  const router = useRouter();

  useEffect(() => {
    fetch('/api/anomalies').then((r) => r.json()).then((d) => setItems(d.anomalies ?? []));
    fetch('/api/remediation').then((r) => r.json()).then((d) => setProposals(d.proposals ?? [])).catch(() => {});
  }, []);

  const propose = async (p: Proposal) => {
    setBusyKind(p.kind);
    try {
      const res = await fetch('/api/remediation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: p.kind }),
      });
      const data = (await res.json().catch(() => ({}))) as ProposeResult;
      setResults((rs) => ({ ...rs, [p.kind]: data }));
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Needs attention</CardTitle>
          <CardDescription>Automatic scans: price variance, duplicates, receivables spikes — with proposed fixes</CardDescription>
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
            {proposals.map((p) => {
              const r = results[p.kind];
              return (
                <div key={p.kind + p.title} className="rounded-md border px-3 py-2 text-left text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <button onClick={() => router.push(`/?explain=${encodeURIComponent(p.kind)}`)} className="min-w-0 flex-1 text-left hover:bg-muted/50">
                      <span className={p.severity === 'high' ? 'text-destructive' : 'text-amber-600'}>● </span>
                      <span className="font-medium">{p.title}</span>
                      <span className="block text-muted-foreground">{p.detail}</span>
                    </button>
                    {p.actionType && !r && (
                      <Button size="sm" variant="outline" onClick={() => propose(p)} disabled={busyKind === p.kind}>
                        <WrenchIcon className="mr-1 h-3 w-3" /> {busyKind === p.kind ? 'Proposing…' : 'Propose fix'}
                      </Button>
                    )}
                  </div>
                  {p.preview && !r && <p className="mt-1 border-t pt-1 text-[11px] text-muted-foreground">Fix: {p.preview}</p>}
                  {r && (
                    <p className={`mt-1 border-t pt-1 text-[11px] ${r.error ? 'text-destructive' : 'text-emerald-600'}`}>
                      {r.error
                        ? `Failed: ${r.error}`
                        : r.decision === 'auto'
                          ? 'Fix executed automatically (policy: auto).'
                          : r.decision === 'ask'
                            ? `Fix queued in the approvals inbox${r.approvalId ? ` (${r.approvalId.slice(0, 8)}…)` : ''} — approve to execute.`
                            : `Policy said: ${r.decision} — ${r.reason ?? ''}`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
