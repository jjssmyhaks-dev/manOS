'use client';

import { useState } from 'react';
import { GlobeIcon, ChevronDownIcon, DatabaseIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Vercel AI Elements — Sources
 * https://ai-sdk.dev/elements/components/sources
 *
 * Shows cited data sources for an answer ("every AI answer shows its data
 * source and as-of time" — PRD §9 UX rules).
 */

export interface SourceDoc {
  href?: string;
  title: string;
  asOf?: string;
}

export function Sources({ sources, className }: { sources: SourceDoc[]; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className={cn('rounded-lg border bg-card text-xs', className)}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <GlobeIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">Sources</span>
        <Badge count={sources.length} />
        <ChevronDownIcon className={cn('ml-auto h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="space-y-1 border-t px-3 py-2">
          {sources.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <DatabaseIcon className="h-3 w-3 text-muted-foreground" />
              {s.href ? (
                <a href={s.href} target="_blank" rel="noreferrer" className="text-primary hover:underline">{s.title}</a>
              ) : (
                <span>{s.title}</span>
              )}
              {s.asOf && <span className="ml-auto text-muted-foreground">as of {s.asOf}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Badge({ count }: { count: number }) {
  return <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{count}</span>;
}

export function Source({ href, title }: { href: string; title: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">{title}</a>;
}
