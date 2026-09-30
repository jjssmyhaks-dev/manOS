'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ActivityIcon, SearchIcon, Undo2Icon, ThumbsUpIcon, ThumbsDownIcon, CheckCircle2Icon, Clock3Icon, XCircleIcon } from 'lucide-react';

interface ActionRow {
  id: string;
  actor: string;
  action_type: string;
  summary: string;
  reason: string | null;
  sources: Array<{ type: string; label: string; ref?: string }>;
  status: string;
  executed_at: string | null;
  undone_at: string | null;
  feedback: string | null;
  created_at: string;
  undoWindow: string | null;
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_BADGE: Record<string, { variant: 'success' | 'warning' | 'destructive' | 'secondary'; label: string }> = {
  executed: { variant: 'success', label: 'done' },
  awaiting_approval: { variant: 'warning', label: 'waiting for you' },
  draft: { variant: 'secondary', label: 'draft' },
  failed: { variant: 'destructive', label: 'failed' },
  undone: { variant: 'secondary', label: 'undone' },
};

export function ActivityClient() {
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (q?: string) => {
    const d = await fetch(`/api/activity${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.json());
    setRows(d.actions ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const undo = async (id: string) => {
    setBusy(id);
    setMsg(null);
    try {
      const res = await fetch('/api/activity', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'undo', id }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; compensations?: string[] };
      setMsg(
        d.ok
          ? { ok: true, text: `Undone. ${(d.compensations ?? []).join(' ')}` }
          : { ok: false, text: d.error ?? 'Could not undo' }
      );
      await load(search || undefined);
    } finally {
      setBusy(null);
    }
  };

  const feedback = async (id: string, up: boolean) => {
    await fetch('/api/activity', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'feedback', id, feedback: up ? 'up' : 'down' }),
    });
    await load(search || undefined);
  };

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold"><ActivityIcon className="h-5 w-5 text-primary" /> AI Activity</h1>
        <p className="text-xs text-muted-foreground">
          Everything the AI did, why it did it, and the data it used. Undo anything it executed in the last 24 hours — nothing is ever deleted.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <SearchIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(search || undefined); }}
            placeholder="Search activity — invoice no, customer, action…"
            className="pl-8 text-xs"
            aria-label="Search AI activity"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => load(search || undefined)}>Search</Button>
      </div>

      {msg && (
        <div className={`rounded-md border px-3 py-2 text-xs ${msg.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      <div className="space-y-2">
        {rows.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nothing yet — the timeline fills up as the agent reads documents, drafts actions and executes them.
            </CardContent>
          </Card>
        )}
        {rows.map((r) => {
          const badge = STATUS_BADGE[r.status] ?? { variant: 'secondary' as const, label: r.status };
          const canUndo = Boolean(r.undoWindow) && r.status === 'executed';
          return (
            <Card key={r.id}>
              <CardContent className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      <span className="text-xs text-muted-foreground">{timeAgo(r.created_at)} · {r.actor === 'agent' ? 'the AI' : r.actor}</span>
                      {r.feedback === 'up' && <ThumbsUpIcon className="h-3 w-3 text-emerald-600" />}
                      {r.feedback === 'down' && <ThumbsDownIcon className="h-3 w-3 text-red-500" />}
                    </div>
                    <p className="mt-1 text-sm">{r.summary}</p>
                    {r.reason && <p className="mt-0.5 text-xs text-muted-foreground">Why: {r.reason}</p>}
                    {r.sources.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {r.sources.map((src, i) => (
                          <span key={i} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                            read: {src.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {canUndo && (
                      <>
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Clock3Icon className="h-3 w-3" /> undo window open</span>
                        <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => undo(r.id)}>
                          <Undo2Icon className="mr-1 h-3 w-3" /> {busy === r.id ? 'Undoing…' : 'Undo'}
                        </Button>
                      </>
                    )}
                    {r.status === 'undone' && <span className="text-[11px] text-muted-foreground">undone {r.undone_at ? timeAgo(r.undone_at) : ''}</span>}
                    {r.status === 'executed' && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => feedback(r.id, true)} aria-label="Good action"><ThumbsUpIcon className="h-3.5 w-3.5" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => feedback(r.id, false)} aria-label="Bad action"><ThumbsDownIcon className="h-3.5 w-3.5" /></Button>
                      </div>
                    )}
                    {r.status === 'failed' && <span className="flex items-center gap-1 text-[11px] text-red-600"><XCircleIcon className="h-3 w-3" /> failed</span>}
                    {r.status === 'executed' && !canUndo && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><CheckCircle2Icon className="h-3 w-3" /> complete</span>}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
