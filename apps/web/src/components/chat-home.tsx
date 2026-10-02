'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Conversation, ConversationEmptyState, Message, PromptInput, Suggestions, Sources,
} from '@/components/ai-elements';
import type { MessagePart } from '@/components/ai-elements/message';

const SUGGESTED = [
  { label: 'Overdue > 45 days', prompt: 'Which customers are overdue more than 45 days, and what is our exposure?' },
  { label: 'This month sales', prompt: 'What is our sales total for the last 30 days?' },
  { label: 'Low stock', prompt: 'Which items need reordering and how much should we buy?' },
  { label: 'Top customers', prompt: 'Show sales by customer for the last 30 days.' },
  { label: 'Open jobs', prompt: 'How many job cards are open right now, by machine?' },
  { label: 'Is 20mm bracket in stock?', prompt: 'Do we have MS Bracket 200mm in stock?' },
];

export function ChatHome() {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const [input, setInput] = useState('');
  const params = useSearchParams();

  const send = (text: string) => {
    if (!text.trim()) return;
    sendMessage({ text });
  };

  // Cmd+K "Ask the AI" deep link: /chat?q=… sends the question on arrival
  useEffect(() => {
    const q = params.get('q');
    if (q?.trim()) {
      send(q.trim());
      setInput(q.trim());
      window.history.replaceState(null, '', '/chat');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = status === 'submitted' || status === 'streaming';

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b px-4 py-3">
        <h1 className="text-sm font-semibold">Ask your factory</h1>
        <p className="text-xs text-muted-foreground">
          Data chat over your connected Tally/Excel operations data — every answer shows its source.
        </p>
      </header>

      <Conversation>
        {messages.length === 0 ? (
          <ConversationEmptyState
            title="Ask your factory anything"
            hint="Sales, stock, receivables, production — in English, Hindi or Hinglish. Numbers come from your data via tools, never from the model's memory."
          />
        ) : (
          messages.map((m) => (
            <Message
              key={m.id}
              from={m.role === 'user' ? 'user' : 'assistant'}
              parts={(m.parts ?? []) as unknown as MessagePart[]}
            />
          ))
        )}
        {error ? (
          <div className="mx-auto max-w-3xl rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Something went wrong: {error.message}
          </div>
        ) : null}
      </Conversation>

      {messages.length === 0 && (
        <div className="border-t bg-background px-4 py-3">
          <Suggestions suggestions={SUGGESTED} onPick={send} />
        </div>
      )}

      <PromptInput onSubmit={send} disabled={busy} />
    </div>
  );
}
