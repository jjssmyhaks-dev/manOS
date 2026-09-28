'use client';

import { useState } from 'react';
import { Loader2Icon, WrenchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Vercel AI Elements — Tool
 * https://ai-sdk.dev/elements/components/tool
 *
 * Renders a tool part through its full state machine:
 * input-streaming → input-available → output-available → output-error.
 */

export type ToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

export interface ToolPartProps {
  toolName: string;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  defaultOpen?: boolean;
  className?: string;
}

const stateLabel: Record<ToolState, string> = {
  'input-streaming': 'preparing…',
  'input-available': 'running…',
  'output-available': 'done',
  'output-error': 'error',
};

export function Tool({ toolName, state, input, output, errorText, defaultOpen = false, className }: ToolPartProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('rounded-lg border bg-card text-xs shadow-sm', className)}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="flex items-center gap-2 font-medium">
          <WrenchIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <code className="rounded bg-muted px-1 py-0.5">{toolName}</code>
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          {state === 'input-streaming' || state === 'input-available' ? (
            <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          {stateLabel[state]}
          <span>{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          <div>
            <div className="mb-1 text-muted-foreground">Input</div>
            <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{safeJson(input)}</pre>
          </div>
          {output !== undefined && (
            <div>
              <div className="mb-1 text-muted-foreground">Output</div>
              <pre className="scrollbar-thin max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{safeJson(output)}</pre>
            </div>
          )}
          {errorText && <div className="rounded bg-destructive/10 p-2 text-red-700">{errorText}</div>}
        </div>
      )}
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? 'null';
  } catch {
    return String(v);
  }
}
