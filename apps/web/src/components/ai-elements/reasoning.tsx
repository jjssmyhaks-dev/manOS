'use client';

import { useState } from 'react';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Vercel AI Elements — Reasoning
 * https://ai-sdk.dev/elements/components/reasoning
 *
 * Collapsible display of the model's reasoning stream (thinking tokens).
 */

export function Reasoning({
  isStreaming = false,
  open,
  onOpenChange,
  children,
  className,
}: {
  isStreaming?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = (v: boolean) => {
    setInternalOpen(v);
    onOpenChange?.(v);
  };

  return (
    <div className={cn('rounded-lg border bg-muted/40 text-xs', className)}>
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 font-medium text-muted-foreground">
          <BrainIcon className="h-3.5 w-3.5" />
          {isStreaming ? 'Thinking…' : 'Reasoning'}
        </span>
        <ChevronDownIcon className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
      </button>
      {isOpen && <div className="border-t px-3 py-2 text-muted-foreground">{children}</div>}
    </div>
  );
}
