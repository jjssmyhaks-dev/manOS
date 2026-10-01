'use client';

import { useEffect } from 'react';

/**
 * Route error boundary: a render/data failure on any surface shows a
 * retryable page instead of a white screen — the factory OS must fail soft.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('app error boundary:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The page hit an unexpected error. Your data is safe — retry, or head back to the dashboard.
        {error?.digest ? <span className="mt-2 block font-mono text-xs opacity-60">ref: {error.digest}</span> : null}
      </p>
      <div className="flex gap-3">
        <button onClick={reset} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Try again
        </button>
        <a href="/dashboard" className="rounded-md border px-4 py-2 text-sm">
          Go to dashboard
        </a>
      </div>
    </div>
  );
}
