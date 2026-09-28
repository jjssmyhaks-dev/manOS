'use client';

import { useRef, useEffect, useState } from 'react';
import { ArrowUpIcon, PaperclipIcon, MicIcon, SquareIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Vercel AI Elements — PromptInput
 * https://ai-sdk.dev/elements/components/prompt-input
 *
 * Autosizing textarea with submit button, attachment + voice affordances
 * (attachments and STT are P1; wired to POST /api/chat via useChat).
 */

export function PromptInput({
  onSubmit,
  placeholder = 'Ask your factory anything…',
  disabled,
  className,
}: {
  onSubmit: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue('');
  };

  return (
    <div className={cn('border-t bg-background p-3', className)}>
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm"
      >
        <button type="button" aria-label="Attach" className="rounded-full p-2 text-muted-foreground hover:bg-muted" disabled>
          <PaperclipIcon className="h-4 w-4" />
        </button>
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder={placeholder}
          className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button type="button" aria-label="Voice note" className="rounded-full p-2 text-muted-foreground hover:bg-muted" disabled>
          <MicIcon className="h-4 w-4" />
        </button>
        <Button type="submit" size="icon" className="rounded-full" disabled={disabled || !value.trim()} aria-label="Send">
          <ArrowUpIcon className="h-4 w-4" />
        </Button>
      </form>
      <div className="mx-auto mt-1 max-w-3xl px-2 text-[11px] text-muted-foreground">
        Answers come from your connected data. Hindi/Hinglish supported — जैसे "इस महीने की सेल कितनी हुई?"
      </div>
    </div>
  );
}
