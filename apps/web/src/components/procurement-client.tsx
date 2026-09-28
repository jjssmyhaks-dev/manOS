'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2Icon, SendIcon } from 'lucide-react';

interface LowStockItem {
  itemId: string;
  item: string | null;
  stockOnHand: number;
  reorderPoint: number;
  suggestedQty: number;
  uom: string | null;
}

interface RfqRow {
  id: string;
  code: string | null;
  status: string | null;
  party_id: string | null;
  qty: number | null;
  data: { item?: string; vendor?: string; needBy?: string };
}

export function ProcurementClient() {
  const [items, setItems] = useState<LowStockItem[]>([]);
  const [rfqs, setRfqs] = useState<RfqRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, r] = await Promise.all([
      fetch('/api/metrics?key=low_stock_items').then((x) => x.json()),
      fetch('/api/procurement').then((x) => x.json()),
    ]);
    setItems(m.breakdown ?? []);
    setRfqs(r.rfqs ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const draftRfqs = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/procurement', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'draft_rfqs' }),
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
          <h1 className="text-lg font-semibold">Procurement</h1>
          <p className="text-xs text-muted-foreground">
            Reorder detection → RFQ drafts → vendor comparison → PO for approval (F5, Flow 4).
          </p>
        </div>
        <Button onClick={draftRfqs} disabled={busy}>
          {busy ? <Loader2Icon className="h-4 w-4 animate-spin" /> : <SendIcon className="h-4 w-4" />} Draft RFQs for low stock
        </Button>
      </div>

      {msg && <div className="rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">{msg}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Reorder watchlist</CardTitle>
          <CardDescription>Stock at/below reorder point with suggested quantities</CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing below reorder point.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-1.5">Item</th><th>On hand</th><th>ROP</th><th>Suggested</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i, idx) => (
                  <tr key={idx} className="border-b last:border-0">
                    <td className="py-1.5 font-medium">{i.item ?? '—'}</td>
                    <td>{i.stockOnHand} {i.uom}</td>
                    <td>{i.reorderPoint}</td>
                    <td className="font-medium text-primary">{i.suggestedQty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">RFQs</CardTitle>
          <CardDescription>Drafted by the agent; sends wait for approval</CardDescription>
        </CardHeader>
        <CardContent>
          {rfqs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No RFQs yet.</p>
          ) : (
            <div className="space-y-2">
              {rfqs.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-xs">
                  <span className="font-medium">{r.data?.item ?? r.code}</span>
                  <span>× {r.qty}</span>
                  <span className="text-muted-foreground">→ {r.data?.vendor ?? 'vendor?'}</span>
                  {r.data?.needBy ? <span className="text-muted-foreground">need by {r.data.needBy}</span> : null}
                  <Badge variant={r.status === 'sent' ? 'success' : 'secondary'} className="ml-auto">{r.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
