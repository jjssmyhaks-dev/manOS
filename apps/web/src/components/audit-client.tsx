'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollTextIcon } from 'lucide-react';

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export function AuditClient() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/audit?limit=200').then((r) => r.json()).then((d) => setRows(d.entries ?? []));
  }, []);

  const filtered = rows.filter((r) => !q || r.action.includes(q.toLowerCase()) || r.actor.includes(q.toLowerCase()));

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold"><ScrollTextIcon className="h-5 w-5" /> Audit log</h1>
        <p className="text-xs text-muted-foreground">Who/what/when for every write, AI action and connector event (F8).</p>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter by action or actor…"
        className="w-full max-w-sm rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-muted-foreground">
                <th className="px-3 py-2">When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-3 py-1.5">{new Date(r.created_at).toLocaleString('en-IN')}</td>
                  <td><Badge variant="outline">{r.actor}</Badge></td>
                  <td className="font-medium">{r.action}</td>
                  <td>{r.entity_type ?? '—'}</td>
                  <td className="max-w-md truncate text-muted-foreground">{r.metadata ? JSON.stringify(r.metadata) : '—'}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No audit entries.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
