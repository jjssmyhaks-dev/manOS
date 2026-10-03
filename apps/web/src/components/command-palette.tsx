'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NAV } from '@/components/app-shell';
import { SparklesIcon, PlayIcon, SendIcon, ClipboardListIcon, SearchIcon, CheckCircle2Icon, XCircleIcon, Loader2Icon } from 'lucide-react';

/**
 * Cmd+K command palette: fuzzy-ish navigation across every workspace surface,
 * a direct "ask the AI" entry (lands in /chat with the question prefilled),
 * and quick actions that call real API endpoints with confirmation toasts.
 * Keyboard-first — the factory owner's hands are often elsewhere; this is the
 * fastest path to any surface. Toasts outlive the palette (fixed stack), so
 * a fired action still reports its result after the overlay closes.
 */

interface Item {
  key: string;
  label: string;
  hint: string;
  group: 'Navigate' | 'Ask' | 'Actions';
  icon: React.ComponentType<{ className?: string }>;
  run?: (router: ReturnType<typeof useRouter>) => void;
  /** API-backed action; resolves with the success toast text, throws on failure. */
  action?: () => Promise<string>;
}

interface Toast {
  id: number;
  kind: 'ok' | 'err' | 'busy';
  text: string;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextToastId = useRef(1);

  const pushToast = (kind: Toast['kind'], text: string) => {
    const id = nextToastId.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
    return id;
  };
  const dropToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  const items: Item[] = useMemo(() => {
    const nav: Item[] = NAV.map(({ href, label, icon }) => ({
      key: `nav:${href}`,
      label,
      hint: href,
      group: 'Navigate' as const,
      icon,
      run: (r) => r.push(href),
    }));
    const ask: Item = {
      key: 'ask:chat',
      label: query.trim() ? `Ask the AI: “${query.trim()}”` : 'Ask the AI',
      hint: 'type a question, then Enter',
      group: 'Ask',
      icon: SparklesIcon,
      run: (r) => r.push(`/chat?q=${encodeURIComponent(query.trim())}`),
    };
    const actions: Item[] = [
      {
        key: 'action:sweep',
        label: 'Run the daily agent sweep now',
        hint: 'digest · anomalies · drafts · dispatch',
        group: 'Actions',
        icon: PlayIcon,
        action: async () => {
          const r = await fetch('/api/jobs/run', { method: 'POST' }).then((x) => x.json());
          if (!r.ok) throw new Error(r.error ?? 'sweep failed');
          return `Sweep done — ${r.overdue} overdue, ${r.anomalies} anomalies${r.urgent ? ` (${r.urgent} urgent)` : ''}, drafts: ${r.collections}, ${r.maintenance}. Outbox: ${r.dispatch.sent} sent, ${r.dispatch.echoed} echoed.`;
        },
      },
      {
        key: 'action:dispatch',
        label: 'Dispatch queued WhatsApp',
        hint: 'send everything waiting in the outbox',
        group: 'Actions',
        icon: SendIcon,
        action: async () => {
          const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'dispatch_now' }),
          }).then((x) => x.json());
          if (!r.ok && !r.sent && r.error) throw new Error(r.error);
          return `Outbox flushed — ${r.sent ?? 0} sent, ${r.echoed ?? 0} echoed${r.failed ? `, ${r.failed} failed` : ''}.`;
        },
      },
      {
        key: 'action:pilot-digest',
        label: 'Force pilot digest now',
        hint: 'weekly operator report · operator only',
        group: 'Actions',
        icon: ClipboardListIcon,
        action: async () => {
          const r = await fetch('/api/jobs/pilot-digest', { method: 'POST' }).then((x) => x.json());
          if (!r.ok) throw new Error(r.error === 'unauthorized' ? 'operator only — set OPERATOR_EMAIL to your account' : r.error ?? 'digest failed');
          return `Pilot digest generated for ${r.orgs} workspace${r.orgs === 1 ? '' : 's'} and queued for delivery.`;
        },
      },
      {
        key: 'action:pilot',
        label: 'Open pilot cockpit',
        hint: '/pilot · operator only',
        group: 'Actions',
        icon: SearchIcon,
        run: (r) => r.push('/pilot'),
      },
    ];
    return [...nav, ask, ...actions];
  }, [query]);

  const execute = async (item: Item) => {
    if (item.action) {
      setOpen(false);
      const busyId = pushToast('busy', `${item.label}…`);
      try {
        const msg = await item.action();
        dropToast(busyId);
        pushToast('ok', msg);
      } catch (e) {
        dropToast(busyId);
        pushToast('err', e instanceof Error ? e.message : 'action failed');
      }
      return;
    }
    setOpen(false);
    item.run?.(router);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.group !== 'Ask' && (i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q))
    ).concat([items.find((i) => i.group === 'Ask')!]);
  }, [items, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery('');
        setSelected(0);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  const groups: Array<Item['group']> = ['Navigate', 'Ask', 'Actions'];

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-lg border bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelected((s) => Math.min(s + 1, filtered.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelected((s) => Math.max(s - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const item = filtered[selected];
                  if (item) void execute(item);
                }
              }}
              placeholder="Search pages, run an action, or ask the AI…"
              className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="max-h-[50vh] overflow-y-auto py-1">
              {groups.map((g) => {
                const rows = filtered.filter((i) => i.group === g);
                if (!rows.length) return null;
                return (
                  <div key={g}>
                    <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</div>
                    {rows.map((item) => {
                      const idx = filtered.indexOf(item);
                      const active = idx === selected;
                      return (
                        <button
                          key={item.key}
                          onMouseEnter={() => setSelected(idx)}
                          onClick={() => void execute(item)}
                          className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${active ? 'bg-muted' : ''}`}
                        >
                          <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {filtered.length === 0 && <p className="px-4 py-6 text-center text-xs text-muted-foreground">No matches.</p>}
            </div>
            <div className="flex items-center gap-3 border-t px-4 py-1.5 text-[10px] text-muted-foreground">
              <span>↑↓ navigate</span>
              <span>↵ run</span>
              <span>esc close</span>
              <span className="ml-auto">⌘K</span>
            </div>
          </div>
        </div>
      )}

      {/* toast stack — survives palette close so fired actions report back */}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-lg ${
                t.kind === 'ok'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : t.kind === 'err'
                    ? 'border-red-200 bg-red-50 text-red-800'
                    : 'border-border bg-background text-foreground'
              }`}
            >
              {t.kind === 'ok' ? (
                <CheckCircle2Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              ) : t.kind === 'err' ? (
                <XCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
              ) : (
                <Loader2Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
