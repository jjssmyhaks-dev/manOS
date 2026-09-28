'use client';

import { useCallback, useState } from 'react';

export function useCopyToClipboard(timeout = 1500) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), timeout);
      } catch {
        /* clipboard unavailable */
      }
    },
    [timeout]
  );

  return { copied, copyToClipboard };
}
