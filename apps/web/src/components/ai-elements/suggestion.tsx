'use client';

import { cn } from '@/lib/utils';

/**
 * Vercel AI Elements — Suggestion
 * https://ai-sdk.dev/elements/components/suggestion
 */

export interface SuggestionItem {
  label: string;
  prompt: string;
}

export function Suggestions({
  suggestions,
  onPick,
  className,
}: {
  suggestions: SuggestionItem[];
  onPick: (prompt: string) => void;
  className?: string;
}) {
  if (!suggestions.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {suggestions.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => onPick(s.prompt)}
          className="rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
