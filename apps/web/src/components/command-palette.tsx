'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NAV } from '@/components/app-shell';
import { SparklesIcon, SearchIcon, CornerDownLeftIcon } from 'lucide-react';

/**
 * Cmd+K command palette: fuzzy-ish navigation across every workspace surface,
 * a direct "ask the AI" entry (lands in /chat with the question prefilled),
 * and quick actions. Keyboard-first — the factory owner's hands are often
 * elsewhere; this is the fastest path to any surface.
 */

interface Item {
  key: string;
  label: string;
  hint: string;
  group: 'Navigate' | 'Ask' | 'Actions';
  icon: React.ComponentType<{ className?: string }>;
  run: (router: ReturnType<typeof useRouter>) => void;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

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
        key: 'action:digest',
        label: 'Run the daily agent sweep now',
        hint: 'digest · reminders · anomalies · forecast',
        group: 'Actions',
        icon: CornerDownLeftIcon,
        run: (r) => r.push('/digest'),
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

  if (!open) return null;

  const groups: Array<Item['group']> = ['Navigate', 'Ask', 'Actions'];
  let flat = 0;

  return (
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
              if (item) {
                setOpen(false);
                item.run(router);
              }
            }
          }}
          placeholder="Search pages, or type a question for the AI…"
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
                  const idx = flat++;
                  const active = idx === selected;
                  return (
                    <button
                      key={item.key}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => {
                        setOpen(false);
                        item.run(router);
                      }}
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
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto">⌘K</span>
        </div>
      </div>
    </div>
  );
}
