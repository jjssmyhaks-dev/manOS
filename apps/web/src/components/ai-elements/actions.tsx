'use client';

import { useState } from 'react';
import { CheckIcon, XIcon, PencilIcon, AlertTriangleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Vercel AI Elements — Actions / Confirmation
 * https://ai-sdk.dev/elements/components/actions
 *
 * Used by the Approvals inbox: preview a pending agent action, then
 * approve / edit / reject. Edit expands the JSON payload for a human to
 * correct (amount, message, channel…) before approving — the saved payload
 * is what the executor runs, so edits are authoritative, not cosmetic.
 */

export function Actions({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export function Action({
  label,
  onClick,
  icon,
  tooltip,
}: {
  label?: string;
  onClick?: () => void;
  icon?: React.ReactNode;
  tooltip?: string;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} title={tooltip}>
      {icon}
      {label}
    </Button>
  );
}

/** Stringify scalar-ish payload values for the edit form; objects become JSON. */
function displayValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.parse(t); } catch { /* keep as string */ }
  }
  return raw;
}

export function Confirmation({
  title,
  preview,
  risk,
  status,
  payload,
  onApprove,
  onReject,
  onSave,
  className,
}: {
  title: string;
  preview: string;
  risk: 'write' | 'external' | string;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  payload?: Record<string, unknown>;
  onApprove?: () => void;
  onReject?: () => void;
  onSave?: (payload: Record<string, unknown>) => Promise<void>;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Array<[string, string]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = status === 'pending';
  const editable = pending && typeof onSave === 'function' && payload !== undefined;

  const startEdit = () => {
    setError(null);
    setRows(Object.entries(payload ?? {}).map(([k, v]) => [k, displayValue(v)]));
    setEditing(true);
  };

  const buildPayload = (): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of rows ?? []) {
      const key = k.trim();
      if (!key) continue;
      try {
        out[key] = parseValue(raw);
      } catch {
        setError(`Invalid JSON in "${key}"`);
        return null;
      }
    }
    return out;
  };

  const save = async () => {
    if (!onSave) return;
    const next = buildPayload();
    if (!next) return;
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('rounded-lg border bg-card shadow-sm', className)}>
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <AlertTriangleIcon className={cn('h-3.5 w-3.5', risk === 'external' ? 'text-amber-500' : 'text-primary')} />
        <span className="font-semibold">{title}</span>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {risk === 'external' ? 'external' : 'write'} · {status}
        </span>
      </div>
      <div className="px-3 py-2 text-sm">{preview}</div>

      {editing && rows && (
        <div className="space-y-2 border-t bg-muted/40 px-3 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Edit payload — the executor runs exactly what you save
          </p>
          {rows.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={k}
                onChange={(e) => setRows((rs) => (rs ?? []).map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                placeholder="field"
                className="h-8 w-36 bg-card font-mono text-xs"
                aria-label={`Field ${i + 1} name`}
              />
              <Input
                value={v}
                onChange={(e) => setRows((rs) => (rs ?? []).map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                placeholder="value"
                className="h-8 flex-1 bg-card font-mono text-xs"
                aria-label={`Field ${i + 1} value`}
              />
              <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove field" onClick={() => setRows((rs) => (rs ?? []).filter((_, j) => j !== i))}>
                <Trash2Icon className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setRows((rs) => [...(rs ?? []), ['', '']])}>
              <PlusIcon className="h-3.5 w-3.5" /> Field
            </Button>
            <span className="text-[11px] text-muted-foreground">numbers/true/false/JSON auto-typed</span>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button size="sm" disabled={busy} onClick={save}>
              <CheckIcon className="h-3.5 w-3.5" /> Save
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {pending && !editing && (
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); await onApprove?.(); setBusy(false); }}>
            <CheckIcon className="h-3.5 w-3.5" /> Approve
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); await onReject?.(); setBusy(false); }}>
            <XIcon className="h-3.5 w-3.5" /> Reject
          </Button>
          {editable && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={startEdit}>
              <PencilIcon className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
