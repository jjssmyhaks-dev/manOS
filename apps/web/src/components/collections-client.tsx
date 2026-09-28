'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BellRingIcon, Loader2Icon } from 'lucide-react';

interface OverdueLine {
  invoice: string | null;
  customerId?: string;
  customer: string | null;
  amount: number;
  overdueDays: number;
}

export function CollectionsClient() {
  const [lines, setLines] = useState<OverdueLine[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await fetch('/api/metrics?key=overdue_total').then((r) => r.json());
    const bd = d.breakdown as OverdueBucket | undefined;
    setLines(bd?.lines ?? []);
    setTotal(Number(d.value ?? 0));
  }, []);

  useEffect(() => { load(); }, [load]);

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
                  <th className="py-1.5">Invoice</th><th>Customer</th><th>Amount</th><th>Days overdue</th>
                </tr>
              </thead>
              <tbody>
                {lines.sort((a, b) => b.overdueDays - a.overdueDays).map((l, idx) => (
                  <tr key={idx} className="border-b last:border-0">
                    <td className="py-1.5 font-medium">{l.invoice ?? '—'}</td>
                    <td>{l.customer ?? '—'}</td>
                    <td>₹{l.amount.toLocaleString('en-IN')}</td>
                    <td><Badge variant={l.overdueDays > 60 ? 'destructive' : l.overdueDays > 30 ? 'warning' : 'secondary'}>{l.overdueDays}d</Badge></td>
                  </tr>
                ))}
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
