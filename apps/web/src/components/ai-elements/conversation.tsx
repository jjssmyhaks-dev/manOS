'use client';

import { useRef, useCallback } from 'react';
import { ArrowDownIcon, MessageSquareIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Vercel AI Elements — Conversation
 * https://ai-sdk.dev/elements/components/conversation
 *
 * Scroll-managed container for a chat thread: auto-scroll on new content,
 * scroll-to-bottom affordance when the user scrolls up, empty state.
 */

export interface ConversationProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Show scroll-to-bottom button when scrolled up (default true). */
  stickyScrollButton?: boolean;
}

export function Conversation({ className, stickyScrollButton = true, children, ...props }: ConversationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)} {...props}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="scrollbar-thin flex-1 overflow-y-auto"
        data-streaming-container
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">{children}</div>
        <div ref={bottomRef} />
      </div>
      {stickyScrollButton && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Scroll to bottom"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={scrollToBottom}
        >
          <ArrowDownIcon className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

export function ConversationEmptyState({
  title = 'Ask your factory anything',
  hint,
  className,
}: {
  title?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-16 text-center', className)}>
      <div className="rounded-full bg-muted p-3">
        <MessageSquareIcon className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="text-lg font-semibold">{title}</div>
      {hint ? <div className="max-w-md text-sm text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
