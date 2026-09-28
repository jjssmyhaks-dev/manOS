'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { SparklesIcon } from 'lucide-react';

interface OverdueBucket {
  buckets: { d1_30: number; d31_60: number; d61_90: number; d90plus: number };
  lines: Array<{ invoice: string | null; customer: string | null; amount: number; overdueDays: number }>;
}

export function DashboardClient() {
  const [overdue, setOverdue] = useState<OverdueBucket | null>(null);
  const [salesByCust, setSalesByCust] = useState<Array<{ customer: string; total: number }>>([]);
  const [lowItems, setLowItems] = useState<Array<{ item: string | null; stockOnHand: number; reorderPoint: number; uom: string | null; suggestedQty?: number }>>([]);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/metrics?key=overdue_total').then((r) => r.json()).then((d) => setOverdue(d.breakdown ?? null));
    fetch('/api/metrics?key=sales_by_customer_30d').then((r) => r.json()).then((d) => setSalesByCust(d.breakdown ?? []));
    fetch('/api/metrics?key=low_stock_items').then((r) => r.json()).then((d) => setLowItems(d.breakdown ?? []));
  }, []);

  const bucketData = overdue ? [
    { name: '1-30d', value: overdue.buckets.d1_30 },
    { name: '31-60d', value: overdue.buckets.d31_60 },
    { name: '61-90d', value: overdue.buckets.d61_90 },
    { name: '90d+', value: overdue.buckets.d90plus },
  ] : [];

  const COLORS = ['#2563eb', '#7c3aed', '#f59e0b', '#ef4444'];

  const explain = (metric: string) => {
    // "explain this" opens chat with context (PRD §9 dashboards row)
    router.push(`/?explain=${encodeURIComponent(metric)}`);
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-sm">Receivables ageing</CardTitle>
            <CardDescription>Overdue buckets (₹)</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => explain('overdue_total')}>
            <SparklesIcon className="mr-1 h-3.5 w-3.5" /> Explain
          </Button>
        </CardHeader>
        <CardContent className="h-56">
          {bucketData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bucketData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="name" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                <Tooltip formatter={(v) => `₹${Number(v).toLocaleString('en-IN')}`} />
                <Bar dataKey="value" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <p className="text-sm text-muted-foreground">No overdue invoices 🎉</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-sm">Sales by customer (30d)</CardTitle>
            <CardDescription>Top customers by order value</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => explain('sales_by_customer_30d')}>
            <SparklesIcon className="mr-1 h-3.5 w-3.5" /> Explain
          </Button>
        </CardHeader>
        <CardContent className="h-56">
          {salesByCust.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={salesByCust.slice(0, 6)} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis type="number" fontSize={11} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                <YAxis type="category" dataKey="customer" fontSize={10} width={110} />
                <Tooltip formatter={(v) => `₹${Number(v).toLocaleString('en-IN')}`} />
                <Bar dataKey="total" fill="#7c3aed" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <p className="text-sm text-muted-foreground">No sales in window.</p>}
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-sm">Low stock watchlist</CardTitle>
            <CardDescription>Items at/below reorder point</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => explain('low_stock_items')}>
            <SparklesIcon className="mr-1 h-3.5 w-3.5" /> Explain
          </Button>
        </CardHeader>
        <CardContent>
          {lowItems.length ? (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-1.5">Item</th><th>On hand</th><th>Reorder point</th><th>Suggested qty</th>
                </tr>
              </thead>
              <tbody>
                {lowItems.map((i, idx) => (
                  <tr key={idx} className="border-b last:border-0">
                    <td className="py-1.5 font-medium">{i.item ?? '—'}</td>
                    <td>{i.stockOnHand} {i.uom}</td>
                    <td>{i.reorderPoint}</td>
                    <td className="font-medium text-primary">{i.suggestedQty ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-sm text-muted-foreground">All items above reorder point.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
