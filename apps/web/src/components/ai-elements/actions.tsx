'use client';

import { useState } from 'react';
import { CheckIcon, XIcon, PencilIcon, AlertTriangleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Vercel AI Elements — Actions / Confirmation
 * https://ai-sdk.dev/elements/components/actions
 *
 * Used by the Approvals inbox: preview a pending agent action, then
 * approve / edit / reject. Also renders inline confirm cards in chat.
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

export function Confirmation({
  title,
  preview,
  risk,
  status,
  onApprove,
  onReject,
  className,
}: {
  title: string;
  preview: string;
  risk: 'write' | 'external' | string;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  onApprove?: () => void;
  onReject?: () => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const pending = status === 'pending';

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
      {pending && (
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); await onApprove?.(); setBusy(false); }}>
            <CheckIcon className="h-3.5 w-3.5" /> Approve
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); await onReject?.(); setBusy(false); }}>
            <XIcon className="h-3.5 w-3.5" /> Reject
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => alert('Edit flows open the draft in the relevant module (P1).')}>
            <PencilIcon className="h-3.5 w-3.5" /> Edit
          </Button>
        </div>
      )}
    </div>
  );
}
