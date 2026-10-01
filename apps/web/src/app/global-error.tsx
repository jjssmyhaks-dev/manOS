'use client';

/**
 * Global error boundary — last resort when even the root layout throws
 * (e.g. the DB is unreachable at boot). Replaces Next's blank screen with
 * an honest full-page failure that can hard-reload.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', background: '#fafaf9', color: '#1c1917', margin: 0 }}>
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Factory AI OS failed to start</h1>
          <p style={{ maxWidth: 440, fontSize: 14, opacity: 0.7 }}>
            A critical error stopped the app from rendering. Check the server logs, then reload.
            {error?.digest ? <span style={{ display: 'block', marginTop: 8, fontFamily: 'monospace', fontSize: 12 }}>ref: {error.digest}</span> : null}
          </p>
          <button
            onClick={reset}
            style={{ background: '#1c1917', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 18px', fontSize: 14, cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
