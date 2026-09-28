'use client';

import { useState } from 'react';
import { CopyIcon, CheckIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Vercel AI Elements — Artifact / CodeBlock
 * https://ai-sdk.dev/elements/components/artifact
 *
 * In this build the Artifact renders generated tables/summaries from tools
 * (e.g., quote comparisons, digest previews) in a side panel style card.
 */

export function Artifact({
  title,
  subtitle,
  onClose,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full flex-col rounded-lg border bg-card shadow-sm', className)}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-semibold">{title}</span>
        {subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
        {onClose && (
          <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={onClose} aria-label="Close">
            <XIcon className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="scrollbar-thin flex-1 overflow-auto p-3 text-sm">{children}</div>
    </div>
  );
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="scrollbar-thin max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <span className="absolute right-2 top-2 flex items-center gap-1">
        {language ? <span className="rounded bg-background/80 px-1 text-[10px] text-muted-foreground">{language}</span> : null}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label="Copy code"
          onClick={() => {
            navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
          }}
        >
          {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
        </Button>
      </span>
    </div>
  );
}
