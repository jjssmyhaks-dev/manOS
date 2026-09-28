'use client';

import { memo, useState } from 'react';
import { CheckIcon, CopyIcon, ThumbsDownIcon, ThumbsUpIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { BranchPicker } from '@/components/ai-elements/branch-picker';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { Response as AiResponse } from '@/components/ai-elements/response';

/**
 * Vercel AI Elements — Message
 * https://ai-sdk.dev/elements/components/message
 *
 * Message / MessageContent / MessageAvatar / MessageActions.
 * User bubbles right; assistant renders markdown via Response.
 */

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface MessageType {
  id: string;
  role: MessageRole;
  parts: MessagePart[];
}

const RoleMeta: Record<MessageRole, { label: string; emoji: string; bubble: string }> = {
  user: { label: 'You', emoji: '🧑', bubble: 'bg-primary text-primary-foreground' },
  assistant: { label: 'Factory AI', emoji: '🤖', bubble: 'bg-muted' },
  system: { label: 'System', emoji: '⚙️', bubble: 'bg-muted' },
};

export function Message({
  from,
  parts,
  className,
}: {
  from: MessageRole;
  parts: MessagePart[];
  className?: string;
}) {
  const meta = RoleMeta[from] ?? RoleMeta.assistant;
  return (
    <div className={cn('flex items-start gap-3', from === 'user' && 'flex-row-reverse', className)} data-role={from}>
      <MessageAvatar src={undefined} name={meta.label} emoji={meta.emoji} from={from} />
      <div className={cn('flex min-w-0 max-w-[85%] flex-col gap-1', from === 'user' && 'items-end')}>
        <MessageContent from={from} parts={parts} className={meta.bubble} />
        {from === 'assistant' && <MessageActions />}
      </div>
    </div>
  );
}

export function MessageContent({
  from,
  parts,
  className,
}: {
  from: MessageRole;
  parts: MessagePart[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2 rounded-2xl px-4 py-2.5 text-sm leading-relaxed', className)}>
      {parts.length === 0 ? (
        <span className="text-muted-foreground">…</span>
      ) : (
        parts.map((part, i) => {
          if (part.type === 'text' && typeof part.text === 'string') {
            return from === 'user' ? (
              <span key={i} className="whitespace-pre-wrap">{part.text}</span>
            ) : (
              <AiResponse key={i}>{part.text}</AiResponse>
            );
          }
          if ((part.type as string).startsWith('tool-')) {
            const toolPart = part as { toolName?: string; state?: string; input?: unknown; output?: unknown };
            // AI SDK v5 encodes the tool name in the part type: 'tool-<name>'
            const toolName = toolPart.toolName ?? ((part.type as string).slice('tool-'.length) || 'tool');
            return (
              <ToolMessagePreview
                key={i}
                toolName={toolName}
                state={toolPart.state}
                input={toolPart.input}
                output={toolPart.output}
              />
            );
          }
          return null;
        })
      )}
    </div>
  );
}

function ToolMessagePreview({ toolName, state, input, output }: { toolName: string; state?: string; input?: unknown; output?: unknown }) {
  const [open, setOpen] = useState(false);
  const isPending = state === 'input-streaming' || state === 'input-available';
  return (
    <div className="rounded-lg border bg-background/60 text-xs">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="font-medium">🔧 {toolName} {isPending ? '· running…' : ''}</span>
        <span className="text-muted-foreground">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="space-y-1 border-t px-3 py-2">
          <div className="text-muted-foreground">Input</div>
          <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{safeJson(input)}</pre>
          {output !== undefined && (
            <>
              <div className="text-muted-foreground">Output</div>
              <pre className="scrollbar-thin max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{safeJson(output)}</pre>
            </>
          )}
        </div>
        )}
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? 'null';
  } catch {
    return String(v);
  }
}

export function MessageAvatar({
  src,
  name,
  emoji,
  from,
}: {
  src?: string;
  name: string;
  emoji?: string;
  from?: MessageRole;
}) {
  return (
    <div
      className={cn(
        'flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full border text-sm',
        from === 'user' ? 'bg-primary/10' : 'bg-card'
      )}
      title={name}
    >
      {src ? <img src={src} alt={name} className="h-full w-full rounded-full object-cover" /> : (emoji ?? name.slice(0, 1))}
    </div>
  );
}

export function MessageActions() {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const { copyToClipboard } = useCopyToClipboard();

  const onCopy = () => {
    const el = document.activeElement?.closest('[data-role="assistant"]');
    const text = el?.textContent ?? '';
    copyToClipboard(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="flex items-center gap-1 opacity-60 transition-opacity hover:opacity-100">
      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Copy" onClick={onCopy}>
        {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Good response"
        onClick={() => setVote(vote === 'up' ? null : 'up')}
      >
        <ThumbsUpIcon className={cn('h-3.5 w-3.5', vote === 'up' && 'text-emerald-600')} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Poor response"
        onClick={() => setVote(vote === 'down' ? null : 'down')}
      >
        <ThumbsDownIcon className={cn('h-3.5 w-3.5', vote === 'down' && 'text-red-600')} />
      </Button>
    </div>
  );
}

export const MemoizedMessage = memo(Message);
