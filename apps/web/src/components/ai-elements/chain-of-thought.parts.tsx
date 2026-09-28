import { cn } from '@/lib/utils';

/** Subcomponent shims so the export surface matches AI Elements' shape. */
export function ChainOfThoughtHeader({ children }: { children?: React.ReactNode }) {
  return <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{children}</div>;
}

export function ChainOfThoughtContent({ children }: { children?: React.ReactNode }) {
  return <div className="border-t px-3 py-2">{children}</div>;
}

export function ChainOfThoughtStep({ label, detail, status }: { label: string; detail?: string; status?: string }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className={cn('mt-0.5 h-2 w-2 rounded-full',
        status === 'done' ? 'bg-emerald-500' : status === 'error' ? 'bg-red-500' : 'bg-amber-400')} />
      <span>
        <span className="font-medium">{label}</span>
        {detail ? <span className="text-muted-foreground"> — {detail}</span> : null}
      </span>
    </div>
  );
}
