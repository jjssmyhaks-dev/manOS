'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Confirmation } from '@/components/ai-elements';
import { Badge } from '@/components/ui/badge';
import { InboxIcon, LayersIcon } from 'lucide-react';
import { BatchApprovalCard } from '@/components/batch-approval';

const BATCH_TYPES = ['send_reminder_batch', 'update_reorder_points'];

interface Approval {
  id: string;
  action_type: string;
  entity_type: string | null;
  payload: Record<string, unknown> | string | null;
  preview: string;
  risk: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  requested_by: string;
  decided_by: string | null;
  result: string | null;
  created_at: string;
}

export function ApprovalsClient() {
  const [items, setItems] = useState<Approval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');

  const load = useCallback(async () => {
    const res = await fetch('/api/approvals');
    const data = await res.json();
    setItems(data.approvals ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    try {
      await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const savePayload = async (id: string, payload: Record<string, unknown>) => {
    const res = await fetch('/api/approvals', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, payload }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? 'save failed');
    }
    await load();
  };

  const asPayload = (p: Approval): Record<string, unknown> | undefined => {
    if (p.payload && typeof p.payload === 'object') return p.payload as Record<string, unknown>;
    if (typeof p.payload === 'string') {
      try { return JSON.parse(p.payload) as Record<string, unknown>; } catch { return undefined; }
    }
    return undefined;
  };

  const shown = items.filter((a) => (filter === 'pending' ? a.status === 'pending' : true));

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Approvals inbox</h1>
          <p className="text-xs text-muted-foreground">
            Every agent write/outbound action lands here per the org's policy (auto · ask · deny).
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setFilter('pending')} className={`rounded-full px-3 py-1 text-xs ${filter === 'pending' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>Pending</button>
          <button onClick={() => setFilter('all')} className={`rounded-full px-3 py-1 text-xs ${filter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>All</button>
        </div>
      </div>

      {shown.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <InboxIcon className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Nothing pending. Agents can propose actions from chat or scheduled jobs.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {shown.map((a) => {
            const payload = asPayload(a);
            const isBatch = BATCH_TYPES.includes(a.action_type) && a.status === 'pending';
            return (
              <div key={a.id} className={isBatch ? 'md:col-span-2' : undefined}>
                {isBatch && (
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <LayersIcon className="h-3.5 w-3.5" /> Batch action — every item is previewable and editable before you decide
                  </div>
                )}
                <Confirmation
                  title={a.action_type.replaceAll('_', ' ')}
                  preview={a.preview}
                  risk={a.risk}
                  status={a.status}
                  payload={payload}
                  onApprove={() => decide(a.id, 'approve')}
                  onReject={() => decide(a.id, 'reject')}
                  onSave={async (next) => {
                    setBusyId(a.id);
                    try {
                      await savePayload(a.id, next);
                    } finally {
                      setBusyId(null);
                    }
                  }}
                />
                {isBatch && payload && (
                  <BatchApprovalCard
                    actionType={a.action_type}
                    payload={payload}
                    busy={busyId === a.id}
                    onChange={async (next) => {
                      await savePayload(a.id, next);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
