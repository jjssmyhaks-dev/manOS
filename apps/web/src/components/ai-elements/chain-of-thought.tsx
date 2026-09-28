'use client';

import { useState } from 'react';
import { ListTreeIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Vercel AI Elements — ChainOfThought
 * https://ai-sdk.dev/elements/components/chain-of-thought
 *
 * Stepwise display of agent work: which tools ran, in order, with results.
 * Used on dashboards ("explain this") and in the chat where multi-step
 * tool loops happen.
 */

export interface CoTStep {
  label: string;
  detail?: string;
  status: 'done' | 'running' | 'error';
}

export function ChainOfThought({ steps, defaultOpen = false, className }: { steps: CoTStep[]; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!steps.length) return null;
  return (
    <div className={cn('rounded-lg border bg-card text-xs', className)}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="flex items-center gap-2 font-medium">
          <ListTreeIcon className="h-3.5 w-3.5 text-muted-foreground" />
          How this was computed ({steps.length} step{steps.length > 1 ? 's' : ''})
        </span>
        <ChevronDownIcon className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ol className="space-y-1 border-t px-3 py-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={cn('mt-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px]',
                s.status === 'done' && 'bg-emerald-100 text-emerald-700',
                s.status === 'running' && 'bg-amber-100 text-amber-700',
                s.status === 'error' && 'bg-red-100 text-red-700')}>
                {s.status === 'done' ? '✓' : s.status === 'error' ? '!' : '…'}
              </span>
              <span>
                <span className="font-medium">{s.label}</span>
                {s.detail ? <span className="text-muted-foreground"> — {s.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export { ChainOfThoughtHeader, ChainOfThoughtContent, ChainOfThoughtStep } from './chain-of-thought.parts';
