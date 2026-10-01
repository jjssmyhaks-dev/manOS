import Link from 'next/link';

/** 404 for unknown routes — points operators somewhere useful instead of a dead end. */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        That page doesn&apos;t exist. Try the dashboard, or ask the AI in the chat — it can answer data questions directly.
      </p>
      <div className="flex gap-3">
        <Link href="/dashboard" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Go to dashboard
        </Link>
        <Link href="/chat" className="rounded-md border px-4 py-2 text-sm">
          Ask the AI
        </Link>
      </div>
    </div>
  );
}
