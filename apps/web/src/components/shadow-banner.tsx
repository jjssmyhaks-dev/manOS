'use client';

import { useEffect, useState } from 'react';
import { EyeIcon, ZapIcon } from 'lucide-react';

/**
 * Shadow-mode banner (PRD v2 pilot default): shown on every workspace page
 * while shadow mode is on — the agent drafts everything, executes nothing.
 * One click to go live, with a confirm so nobody flips it by accident.
 */
export function ShadowBanner() {
  const [shadow, setShadow] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then((d) => setShadow(Boolean(d.shadow))).catch(() => setShadow(false));
  }, []);

  if (shadow === null || !shadow) return null;

  const goLive = async () => {
    if (!confirm('Go live? From now the agent can execute actions automatically where your guardrails allow it (Do it). Drafts already queued stay queued.')) return;
    await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set_shadow_mode', enabled: false }),
    });
    setShadow(false);
    location.reload();
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-indigo-50 px-4 py-2 text-xs text-indigo-900">
      <span className="flex items-center gap-2">
        <EyeIcon className="h-4 w-4" />
        <span><strong>Shadow mode:</strong> the AI drafts everything but executes nothing — every action waits for your approval. Perfect for the first weeks.</span>
      </span>
      <button onClick={goLive} className="flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 font-medium text-white hover:bg-indigo-700">
        <ZapIcon className="h-3 w-3" /> Go live
      </button>
    </div>
  );
}
