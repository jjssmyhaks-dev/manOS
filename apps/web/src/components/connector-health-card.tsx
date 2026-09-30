import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ConnectorHealthReport } from '@factory/core';

const LABELS: Record<string, string> = {
  tally: 'Tally Prime',
  csv: 'CSV import',
  whatsapp: 'WhatsApp Cloud',
  gmail: 'Gmail',
  gsp: 'GSP (e-invoice)',
  sarvam: 'Sarvam AI',
};

const VARIANT: Record<ConnectorHealthReport['connectors'][number]['health'], 'success' | 'destructive' | 'warning' | 'secondary'> = {
  ok: 'success',
  error: 'destructive',
  stale: 'warning',
  dormant: 'secondary',
};

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h ${mins % 60} m ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * Connector health (PRD F1): live view of connector liveness — error/stale
 * heartbeats and push backlogs surface here, including failures first
 * detected by the daily monitoring cron (/api/jobs/daily).
 */
export function ConnectorHealthCard({ report }: { report: ConnectorHealthReport }) {
  const active = report.connectors.filter((c) => c.health !== 'dormant');
  const dormant = report.connectors.filter((c) => c.health === 'dormant');

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Connector health</CardTitle>
          <CardDescription>
            Tally &amp; data sync liveness · stale threshold {report.staleAfterMin} min
          </CardDescription>
        </div>
        <Badge variant={report.ok ? 'success' : 'destructive'}>
          {report.ok ? `${active.length || dormant.length} monitored · all healthy` : `${report.failures.length} failure${report.failures.length > 1 ? 's' : ''}`}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {active.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No connectors wired up yet — {dormant.length ? `${dormant.map((c) => LABELS[c.type] ?? c.type).join(', ')} available.` : 'register Tally from the Connectors page.'}
          </p>
        )}

        {active.length > 0 && (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-1.5">Connector</th><th>Status</th><th>Last sync</th><th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {active.map((c) => (
                <tr key={c.type} className="border-b last:border-0 align-top">
                  <td className="py-1.5 font-medium">{LABELS[c.type] ?? c.type}</td>
                  <td><Badge variant={VARIANT[c.health]}>{c.health}</Badge></td>
                  <td>{ago(c.lastSyncAt)}</td>
                  <td className="max-w-[24rem] truncate text-muted-foreground" title={c.lastError ?? undefined}>
                    {c.health === 'error' && c.lastError ? c.lastError : null}
                    {c.type === 'tally' && c.pendingPushes > 0 ? `${c.pendingPushes} voucher${c.pendingPushes > 1 ? 's' : ''} awaiting Tally push` : null}
                    {c.health === 'ok' && !(c.type === 'tally' && c.pendingPushes > 0) ? '—' : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {report.failures.length > 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs">
            {report.failures.map((f, i) => (
              <div key={i} className="py-0.5">
                <span className="font-semibold text-destructive">{LABELS[f.type] ?? f.type}:</span>{' '}
                {f.issue} — {f.detail}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
