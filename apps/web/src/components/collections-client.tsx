'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BellRingIcon, Loader2Icon, FileCheck2Icon, QrCodeIcon } from 'lucide-react';

interface OverdueLine {
  invoice: string | null;
  customerId?: string;
  customer: string | null;
  amount: number;
  overdueDays: number;
}

interface EinvoiceState {
  einvoiced: boolean;
  irn?: string;
  ackNo?: string;
  provider?: string;
  error?: string;
}

export function CollectionsClient() {
  const [lines, setLines] = useState<OverdueLine[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [einv, setEinv] = useState<Record<string, EinvoiceState>>({});
  const [einvBusy, setEinvBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await fetch('/api/metrics?key=overdue_total').then((r) => r.json());
    const bd = d.breakdown as OverdueBucket | undefined;
    setLines(bd?.lines ?? []);
    setTotal(Number(d.value ?? 0));
    // e-invoice status for the visible invoices (best-effort)
    for (const l of bd?.lines ?? []) {
      if (l.invoice) {
        fetch(`/api/einvoice?invoice=${encodeURIComponent(l.invoice)}`).then((r) => r.json()).then((st: EinvoiceState) => {
          setEinv((prev) => ({ ...prev, [l.invoice!]: st }));
        }).catch(() => {});
      }
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const generate = async (invoice: string) => {
    setEinvBusy(invoice);
    try {
      const res = await fetch('/api/einvoice', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invoice }),
      });
      const d = (await res.json()) as EinvoiceState & { alreadyGenerated?: boolean };
      setEinv((prev) => ({ ...prev, [invoice]: d }));
      setMsg(d.einvoiced ? `IRN ${d.alreadyGenerated ? 'already' : ''} generated for ${invoice}` : d.error ?? 'generation failed');
    } finally {
      setEinvBusy(null);
    }
  };

  const draftReminders = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'draft_reminders', minDays: 1, limit: 10, channel: 'whatsapp' }),
      });
      const data = await res.json();
      setMsg(data.details?.join(' · ') ?? data.error ?? 'done');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Collections</h1>
          <p className="text-xs text-muted-foreground">Overdue receivables with reminder drafting (F6). Sends wait for approval.</p>
        </div>
        <Button onClick={draftReminders} disabled={busy || lines.length === 0}>
          {busy ? <Loader2Icon className="h-4 w-4 animate-spin" /> : <BellRingIcon className="h-4 w-4" />} Draft reminders
        </Button>
      </div>

      {msg && <div className="rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">{msg}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Overdue invoices — ₹{total.toLocaleString('en-IN')}</CardTitle>
          <CardDescription>Sorted by oldest due date</CardDescription>
        </CardHeader>
        <CardContent>
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No overdue invoices 🎉</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-1.5">Invoice</th><th>Customer</th><th>Amount</th><th>Days overdue</th><th>E-invoice</th>
                </tr>
              </thead>
              <tbody>
                {lines.sort((a, b) => b.overdueDays - a.overdueDays).map((l, idx) => {
                  const inv = l.invoice ?? '';
                  const st = inv ? einv[inv] : undefined;
                  return (
                    <tr key={idx} className="border-b last:border-0">
                      <td className="py-1.5 font-medium">{l.invoice ?? '—'}</td>
                      <td>{l.customer ?? '—'}</td>
                      <td>₹{l.amount.toLocaleString('en-IN')}</td>
                      <td><Badge variant={l.overdueDays > 60 ? 'destructive' : l.overdueDays > 30 ? 'warning' : 'secondary'}>{l.overdueDays}d</Badge></td>
                      <td>
                        {st?.einvoiced ? (
                          <span className="flex items-center gap-1 text-emerald-600" title={`IRN ${st.irn?.slice(0, 24)}… · ack ${st.ackNo ?? ''} · ${st.provider ?? ''}`}>
                            <QrCodeIcon className="h-3.5 w-3.5" /> {st.irn?.slice(0, 10)}…
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" disabled={einvBusy === inv} onClick={() => generate(inv)}>
                            {einvBusy === inv ? <Loader2Icon className="h-3 w-3 animate-spin" /> : <FileCheck2Icon className="h-3 w-3" />} Generate IRN
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface OverdueBucket {
  buckets: { d1_30: number; d31_60: number; d61_90: number; d90plus: number };
  lines: OverdueLine[];
}
