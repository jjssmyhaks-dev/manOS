'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckIcon, LayersIcon, Trash2Icon, XIcon } from 'lucide-react';

/**
 * Batch approval card (spec A4/A11): actions that bundle N items into ONE
 * approval — reminder batches ("22 reminders ready to send") and reorder-point
 * updates — render each item previewable and individually editable/removable
 * before the single decision. The payload edited here is what the executor
 * runs: removing a row means that message/write never happens.
 */

const BATCH_ITEMS: Record<string, { key: string; fields: string[]; label: (item: Record<string, unknown>) => string }> = {
  send_reminder_batch: {
    key: 'messages',
    fields: ['invoice', 'customer', 'amount', 'text'],
    label: (i) => `${i.customer ?? '?'} — ${i.invoice ?? '?'} (₹${Number(i.amount ?? 0).toLocaleString('en-IN')})`,
  },
  update_reorder_points: {
    key: 'updates',
    fields: ['item', 'from', 'reorderPoint'],
    label: (i) => `${i.item ?? i.itemId ?? '?'}: ${i.from ?? '–'} → ${i.reorderPoint ?? '?'}`,
  },
};

function itemsOf(actionType: string, payload: Record<string, unknown>): { key: string; fields: string[]; rows: Array<Record<string, unknown>> } | null {
  const meta = BATCH_ITEMS[actionType];
  if (!meta) return null;
  const raw = payload[meta.key];
  if (!Array.isArray(raw)) return null;
  return { key: meta.key, fields: meta.fields, rows: raw as Array<Record<string, unknown>> };
}

export function BatchApprovalCard({
  actionType,
  payload,
  busy,
  onChange,
}: {
  actionType: string;
  payload: Record<string, unknown>;
  busy: boolean;
  onChange: (next: Record<string, unknown>) => Promise<void>;
}) {
  const spec = itemsOf(actionType, payload);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyLocal, setBusyLocal] = useState(false);
  const spinning = busy || busyLocal;

  if (!spec) return null;
  const meta = BATCH_ITEMS[actionType]!;

  const startEdit = (idx: number) => {
    setError(null);
    const row = spec.rows[idx] ?? {};
    const d: Record<string, string> = {};
    for (const f of meta.fields) d[f] = row[f] == null ? '' : String(row[f]);
    setDraft(d);
    setEditingIdx(idx);
  };

  const saveEdit = async () => {
    if (editingIdx == null) return;
    const amount = Number(draft.amount);
    const reorderPoint = Number(draft.reorderPoint);
    if (meta.fields.includes('amount') && (!Number.isFinite(amount) || amount < 0)) {
      setError('Amount must be a number ≥ 0');
      return;
    }
    if (meta.fields.includes('reorderPoint') && (!Number.isFinite(reorderPoint) || reorderPoint < 1)) {
      setError('Reorder point must be a number ≥ 1');
      return;
    }
    const next = spec.rows.map((r, i) => {
      if (i !== editingIdx) return r;
      const row = { ...r };
      for (const f of meta.fields) {
        if (f === 'amount') row.amount = amount;
        else if (f === 'reorderPoint') row.reorderPoint = reorderPoint;
        else if (f === 'from') void f; // informational, not editable
        else row[f] = draft[f] ?? '';
      }
      return row;
    });
    setBusyLocal(true);
    try {
      await onChange({ ...payload, [spec.key]: next });
      setEditingIdx(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusyLocal(false);
    }
  };

  const removeRow = async (idx: number) => {
    const next = spec.rows.filter((_, i) => i !== idx);
    setBusyLocal(true);
    try {
      await onChange({ ...payload, [spec.key]: next });
    } finally {
      setBusyLocal(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <LayersIcon className="h-3.5 w-3.5" />
        {spec.rows.length} item{spec.rows.length === 1 ? '' : 's'} in this batch — preview, edit or exclude each one
      </div>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {spec.rows.map((row, i) => (
          <div key={i} className="rounded border bg-card px-2 py-1.5 text-xs">
            {editingIdx === i ? (
              <div className="space-y-1.5">
                {meta.fields
                  .filter((f) => f !== 'from')
                  .map((f) => (
                    <div key={f} className="flex items-start gap-1.5">
                      <span className="w-16 shrink-0 pt-1 text-[10px] uppercase text-muted-foreground">{f}</span>
                      {f === 'text' ? (
                        <textarea
                          value={draft[f] ?? ''}
                          onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
                          rows={3}
                          className="w-full rounded border px-1.5 py-1 text-xs"
                        />
                      ) : (
                        <input
                          value={draft[f] ?? ''}
                          onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
                          className="w-full rounded border px-1.5 py-1 text-xs"
                        />
                      )}
                    </div>
                  ))}
                {error && <p className="text-[11px] text-destructive">{error}</p>}
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={saveEdit} disabled={spinning}>
                    <CheckIcon className="mr-1 h-3 w-3" /> Save item
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingIdx(null)} disabled={spinning}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {meta.label(row)}
                  {row.text ? <span className="block truncate text-[10px] text-muted-foreground">{String(row.text).slice(0, 90)}</span> : null}
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => startEdit(i)} disabled={spinning}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => removeRow(i)} disabled={spinning} title="Exclude from this batch">
                    <Trash2Icon className="h-3 w-3" />
                  </Button>
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
      {spec.rows.length === 0 && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <XIcon className="h-3 w-3" /> Every item excluded — approving will be a no-op; reject instead.
        </p>
      )}
      <Badge variant="outline" className="mt-1.5">
        edits apply to this decision only
      </Badge>
    </div>
  );
}
