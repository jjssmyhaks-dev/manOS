import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

/**
 * Vercel AI Elements — BranchPicker (variant used inside MessageActions).
 */
export function BranchPicker({ count = 1, index = 0 }: { count?: number; index?: number }) {
  if (count <= 1) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <ChevronLeftIcon className="h-3 w-3" />
      {index + 1}/{count}
      <ChevronRightIcon className="h-3 w-3" />
    </span>
  );
}
