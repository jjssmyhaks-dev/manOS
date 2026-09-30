import { getPack, connectorHealth } from '@factory/core';
import { query } from '@factory/db';
import { runMetric } from '@factory/agents';
import { getSession } from '@/lib/session';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DashboardClient } from '@/components/dashboard-client';
import { ConnectorHealthCard } from '@/components/connector-health-card';
import { AnomaliesCard } from '@/components/anomalies-card';
import { OverrideCard } from '@/components/override-card';

export const dynamic = 'force-dynamic';

function inr(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export default async function DashboardPage() {
  const s = await getSession();
  const [sales, cash, overdue, low, delayed] = await Promise.all([
    runMetric(s.orgId, 'sales_last_30d'),
    runMetric(s.orgId, 'cash_position'),
    runMetric(s.orgId, 'overdue_total'),
    runMetric(s.orgId, 'low_stock_items'),
    runMetric(s.orgId, 'top_delayed_orders'),
  ]);
  const pack = getPack(s.vertical);
  const [docCount, health] = await Promise.all([
    query<{ c: string }>(
      `select count(*) as c from documents where org_id=$1 and status='review'`, [s.orgId]
    ),
    connectorHealth(s.orgId),
  ]);

  const kpis = [
    { key: 'sales', label: 'Sales (30d)', value: inr(sales.value ?? 0), sub: `as of ${sales.asOf}`, metricKey: 'sales_last_30d' },
    { key: 'cash', label: 'Collections (30d)', value: inr(cash.value ?? 0), sub: `as of ${cash.asOf}`, metricKey: 'cash_position' },
    { key: 'overdue', label: 'Overdue', value: inr(overdue.value ?? 0), sub: `${((overdue.breakdown as unknown as { lines: unknown[] }).lines ?? []).length} invoices`, metricKey: 'overdue_total' },
    { key: 'low', label: 'Low stock', value: String(low.value ?? 0), sub: 'items at/below ROP', metricKey: 'low_stock_items' },
    { key: 'delayed', label: 'Delayed orders', value: String(delayed.value ?? 0), sub: 'past delivery date', metricKey: 'top_delayed_orders' },
  ];

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{s.orgName}</h1>
          <p className="text-xs text-muted-foreground">
            {pack.label} pack · KPIs: {pack.kpis.map((k) => k.label).join(', ')}
          </p>
        </div>
        <Badge variant={Number(docCount[0]?.c ?? 0) > 0 ? 'warning' : 'success'}>
          {Number(docCount[0]?.c ?? 0)} docs in review
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {kpis.map((k) => (
          <Card key={k.key}>
            <CardHeader className="pb-0">
              <CardTitle className="text-xs font-medium text-muted-foreground">{k.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold">{k.value}</div>
              <div className="text-[11px] text-muted-foreground">{k.sub}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConnectorHealthCard report={health} />

      <AnomaliesCard />

      <OverrideCard />

      <DashboardClient />
    </div>
  );
}
