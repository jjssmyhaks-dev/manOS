'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckIcon, SparklesIcon, MessageCircleIcon, CalendarClockIcon, ShieldCheckIcon, BrainIcon } from 'lucide-react';

interface PolicyRow { action_type: string; decision: 'auto' | 'ask' | 'deny' }
interface FactRow { id: string; fact: string; status: string; source: string }
interface AiOption { key: string; title: string; models: string; blurb: string }
interface AiConfig {
  platform: boolean;
  model_route: string;
  effective: string;
  options: AiOption[];
}
interface NotifyConfig {
  owner_phone: string | null;
  auto_send: boolean;
  mode: 'echo' | 'live';
  phone_number_id_set: boolean;
}
interface AgentJobRow {
  id: string;
  schedule: string;
  instruction: string;
  enabled: boolean;
  last_run_at: string | null;
  last_result: Record<string, unknown> | null;
}

const ACTION_LABELS: Record<string, string> = {
  send_reminder: 'Payment reminders to customers',
  send_rfq: 'RFQs to vendors',
  create_po: 'Purchase orders',
  so_create: 'Sales orders',
  tally_push: 'Vouchers into Tally',
  digest_send: 'The daily digest',
  whatsapp_send: 'WhatsApp messages',
  email_send: 'Emails',
  grn_create: 'Goods receipts (GRN)',
  job_card_update: 'Job card updates',
};

export function SettingsClient() {
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [newFact, setNewFact] = useState('');
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; slug: string; vertical: string }>>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [ai, setAi] = useState<AiConfig | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<string>('default');
  const [savingRoute, setSavingRoute] = useState<string | null>(null);
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [notify, setNotify] = useState<NotifyConfig | null>(null);
  const [phoneInput, setPhoneInput] = useState('');
  const [autoSend, setAutoSend] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [jobs, setJobs] = useState<AgentJobRow[]>([]);
  const [jobSchedule, setJobSchedule] = useState('daily');
  const [jobInstruction, setJobInstruction] = useState('');
  const [jobMsg, setJobMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const s = await fetch('/api/settings').then((r) => r.json());
    setPolicies(s.policies ?? []);
    setFacts(s.facts ?? []);
    if (s.ai) {
      setAi(s.ai);
      setSelectedRoute(s.ai.model_route ?? 'default');
    }
    if (s.notify) {
      setNotify(s.notify);
      setAutoSend(Boolean(s.notify.auto_send));
      setPhoneInput(s.notify.owner_phone ?? '');
    }
    const o = await fetch('/api/org').then((r) => r.json());
    setOrgs(o.orgs ?? []);
    setCurrent(o.session?.orgSlug ?? null);
    fetch('/api/agent-jobs').then((r) => r.json()).then((d) => setJobs(d.jobs ?? [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const setDecision = async (actionType: string, decision: 'auto' | 'ask' | 'deny') => {
    setPolicies((ps) => ps.map((p) => (p.action_type === actionType ? { ...p, decision } : p)));
    await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set_policy', actionType, decision }),
    });
  };

  const pickRoute = async (key: string) => {
    if (!ai || savingRoute) return;
    setSavingRoute(key);
    setAiMsg(null);
    const prev = selectedRoute;
    setSelectedRoute(key);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set_model_route', modelRoute: key }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && d.ok) {
        const opt = ai.options.find((o) => o.key === key);
        setAiMsg({ ok: true, text: `Done — your assistant now runs on ${opt?.title ?? key} (${opt?.models ?? ''}).` });
      } else {
        setSelectedRoute(prev);
        setAiMsg({ ok: false, text: d.error ?? 'Could not save — please try again.' });
      }
    } catch {
      setSelectedRoute(prev);
      setAiMsg({ ok: false, text: 'Network hiccup — please try again.' });
    } finally {
      setSavingRoute(null);
    }
  };

  const addFact = async () => {
    if (!newFact.trim()) return;
    await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add_fact', fact: newFact }),
    });
    setNewFact('');
    await load();
  };

  const archiveFact = async (id: string) => {
    await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'archive_fact', factId: id }),
    });
    await load();
  };

  const saveNotify = async () => {
    setNotifyMsg(null);
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save_notify', ownerPhone: phoneInput.trim() || null, autoSend }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setNotifyMsg(res.ok && data.ok ? { ok: true, text: 'Saved — the agent will reach you here.' } : { ok: false, text: data.error ?? 'Save failed' });
    await load();
  };

  const dispatchNow = async () => {
    setNotifyMsg(null);
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'dispatch_now' }),
    });
    const d = (await res.json().catch(() => ({}))) as { sent?: number; echoed?: number; failed?: number; processed?: number; error?: string };
    setNotifyMsg(
      d.error
        ? { ok: false, text: d.error }
        : { ok: true, text: `Sent: ${d.processed ?? 0} queued · ${d.sent ?? 0} delivered · ${d.echoed ?? 0} test mode · ${d.failed ?? 0} failed.` }
    );
    await load();
  };

  const addJob = async () => {
    if (!jobInstruction.trim()) return;
    setJobMsg(null);
    const res = await fetch('/api/agent-jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', schedule: jobSchedule, instruction: jobInstruction.trim() }),
    });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && d.ok) {
      setJobInstruction('');
      setJobMsg({ ok: true, text: 'Scheduled — the agent will do this and message you the result.' });
    } else {
      setJobMsg({ ok: false, text: d.error ?? 'Could not schedule the task' });
    }
    await load();
  };

  const runJobNow = async (jobId: string) => {
    setJobMsg(null);
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, last_result: { running: true } } : j)));
    const res = await fetch('/api/agent-jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'run_now', jobId }),
    });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; reply?: string; error?: string; notified?: boolean };
    setJobMsg(
      d.ok
        ? { ok: true, text: `Done — the agent replied: “${(d.reply ?? '').slice(0, 90)}…”` }
        : { ok: false, text: d.error ?? 'Run failed' }
    );
    await load();
  };

  const toggleJob = async (jobId: string, enabled: boolean) => {
    await fetch('/api/agent-jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'enable', jobId, enabled }),
    });
    await load();
  };

  const switchOrg = async (slug: string) => {
    await fetch('/api/org', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'switch', slug }),
    });
    location.reload();
  };

  const seedOrg = async (slug: string) => {
    await fetch('/api/org', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'seed', slug }),
    });
    await switchOrg(slug);
  };

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-xs text-muted-foreground">Your AI assistant, WhatsApp delivery and guardrails. Nothing technical required.</p>
      </div>

      {/* AI model — included; subscriber only picks a style */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><SparklesIcon className="h-4 w-4 text-primary" /> AI model — included with your plan</CardTitle>
          <CardDescription>
            Pick how smart (and how frugal) your assistant should be. AI is billed by us, not by you — no API keys, ever.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={ai?.platform ? 'success' : 'warning'}>{ai?.effective ?? '…'}</Badge>
            {ai?.platform && <span className="text-xs text-muted-foreground">Everything is live and included.</span>}
          </div>
          {!ai?.platform && (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              This deployment is running the built-in demo model (no live AI). The platform operator enables live AI by setting the{' '}
              <code className="rounded bg-muted px-1">OPENROUTER_API_KEY</code> environment variable — subscribers never need a key.
            </p>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            {(ai?.options ?? [{ key: 'default', title: 'Smartest', models: 'GPT-4o class', blurb: 'Best explanations, complex documents, trickier Hinglish queries.' },
              { key: 'budget', title: 'Value', models: 'Flash / Sonnet class', blurb: 'Everyday questions at a lower cost — slightly shorter answers.' }]).map((opt) => {
              const selected = selectedRoute === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => pickRoute(opt.key)}
                  disabled={savingRoute !== null}
                  aria-pressed={selected}
                  className={`rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 ${selected ? 'border-primary ring-1 ring-primary' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{opt.title}</span>
                    {selected ? (
                      <Badge variant="success"><CheckIcon className="mr-1 inline h-3 w-3" />Selected</Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">{savingRoute === opt.key ? 'Saving…' : 'Tap to switch'}</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] font-medium text-muted-foreground">{opt.models}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{opt.blurb}</div>
                </button>
              );
            })}
          </div>
          {aiMsg && <p className={`text-xs ${aiMsg.ok ? 'text-emerald-600' : 'text-destructive'}`}>{aiMsg.text}</p>}
          <p className="text-xs text-muted-foreground">Switch anytime — documents use the smart model automatically when accuracy matters.</p>
        </CardContent>
      </Card>

      {/* WhatsApp */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><MessageCircleIcon className="h-4 w-4 text-emerald-600" /> WhatsApp — where answers and alerts land</CardTitle>
          <CardDescription>
            Add your number and the assistant keeps you posted: the daily summary, urgent alerts and anything you ask it to chase.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={notify?.mode === 'live' ? 'success' : 'warning'}>
              {notify ? (notify.mode === 'live' ? 'Live on WhatsApp' : 'Test mode (no real sends)') : '…'}
            </Badge>
            {notify?.mode === 'echo' && (
              <span className="text-xs text-muted-foreground">Sends are recorded for the demo but not delivered — the operator adds WhatsApp credentials for live delivery.</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="Your WhatsApp number, e.g. 919812345678"
              className="max-w-xs font-mono text-xs"
              aria-label="Owner WhatsApp number"
              autoComplete="off"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
              Send the daily digest &amp; alerts automatically (recommended)
            </label>
            <Button size="sm" onClick={saveNotify} disabled={!notify}>Save</Button>
            <Button size="sm" variant="outline" onClick={dispatchNow} disabled={!notify}>Send queued now</Button>
          </div>
          {notifyMsg && <p className={`text-xs ${notifyMsg.ok ? 'text-emerald-600' : 'text-destructive'}`}>{notifyMsg.text}</p>}
          <p className="text-xs text-muted-foreground">
            Your number is also a chat window: message the assistant and it answers from your factory data.
          </p>
        </CardContent>
      </Card>

      {/* Agent tasks */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><CalendarClockIcon className="h-4 w-4 text-blue-600" /> Recurring tasks — tell the agent once</CardTitle>
          <CardDescription>
            Write it like you'd tell an assistant. It runs on schedule, uses the same tools you use in chat, and messages you the outcome.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={jobSchedule}
              onChange={(e) => setJobSchedule(e.target.value)}
              className="h-9 rounded-md border border-input bg-card px-2 text-xs"
              aria-label="Task schedule"
            >
              <option value="daily">Every day</option>
              <option value="weekly:1">Every Monday</option>
              <option value="weekly:2">Every Tuesday</option>
              <option value="weekly:3">Every Wednesday</option>
              <option value="weekly:4">Every Thursday</option>
              <option value="weekly:5">Every Friday</option>
              <option value="weekly:6">Every Saturday</option>
              <option value="weekly:7">Every Sunday</option>
            </select>
            <Input
              value={jobInstruction}
              onChange={(e) => setJobInstruction(e.target.value)}
              placeholder="e.g. Chase every invoice overdue more than 15 days and tell me the total"
              className="min-w-64 flex-1 text-xs"
              aria-label="Agent task instruction"
              onKeyDown={(e) => { if (e.key === 'Enter') addJob(); }}
            />
            <Button size="sm" onClick={addJob} disabled={!jobInstruction.trim()}>Schedule</Button>
          </div>
          {jobMsg && <p className={`text-xs ${jobMsg.ok ? 'text-emerald-600' : 'text-destructive'}`}>{jobMsg.text}</p>}
          {jobs.map((j) => (
            <div key={j.id} className="rounded-md border px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <Badge variant="outline">{j.schedule === 'daily' ? 'Every day' : j.schedule.replace('weekly:', 'Every ')}</Badge>{' '}
                  <span className="font-medium">{j.instruction}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" onClick={() => runJobNow(j.id)}>Run now</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggleJob(j.id, !j.enabled)}>{j.enabled ? 'Pause' : 'Resume'}</Button>
                </div>
              </div>
              <div className="mt-1 text-muted-foreground">
                {j.last_result?.running
                  ? 'Running…'
                  : j.last_run_at
                    ? `Last run ${new Date(j.last_run_at).toLocaleString('en-IN')} — ${String((j.last_result as { reply?: string })?.reply ?? '').slice(0, 80)}`
                    : 'Not run yet — starts on its schedule'}
              </div>
            </div>
          ))}
          {jobs.length === 0 && <p className="text-xs text-muted-foreground">Nothing scheduled yet — try &ldquo;Every Friday, chase overdue invoices past 15 days&rdquo;.</p>}
        </CardContent>
      </Card>

      {/* Guardrails */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><ShieldCheckIcon className="h-4 w-4 text-amber-600" /> Guardrails — what the agent may do without asking</CardTitle>
          <CardDescription>Do it = act immediately · Ask me = wait for your approval · Block = never. Everything it does is logged.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {policies.map((p) => (
            <div key={p.action_type} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>{ACTION_LABELS[p.action_type] ?? p.action_type}</span>
              <div className="flex gap-1">
                {(['auto', 'ask', 'deny'] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDecision(p.action_type, d)}
                    className={`rounded-full px-3 py-1 text-xs ${
                      p.decision === d ? (d === 'deny' ? 'bg-red-600 text-white' : d === 'auto' ? 'bg-emerald-600 text-white' : 'bg-primary text-white') : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {d === 'auto' ? 'Do it' : d === 'ask' ? 'Ask me' : 'Block'}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {policies.length === 0 && <p className="text-sm text-muted-foreground">Loading guardrails…</p>}
        </CardContent>
      </Card>

      {/* Org memory */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><BrainIcon className="h-4 w-4 text-purple-600" /> What your assistant has learned</CardTitle>
          <CardDescription>Rules it follows — from your corrections in chat or notes you add here. Review or remove anytime.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input value={newFact} onChange={(e) => setNewFact(e.target.value)} placeholder="Teach it something, e.g. Always quote rates excluding GST" />
            <Button onClick={addFact}>Teach</Button>
          </div>
          {facts.map((f) => (
            <div key={f.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>{f.fact}</span>
              <div className="flex items-center gap-2">
                <Badge variant={f.source === 'agent' ? 'success' : 'outline'}>{f.source === 'agent' ? 'learned in chat' : 'added by you'}</Badge>
                <Button size="sm" variant="ghost" onClick={() => archiveFact(f.id)}>Remove</Button>
              </div>
            </div>
          ))}
          {facts.length === 0 && <p className="text-xs text-muted-foreground">Nothing learned yet — correct the assistant in chat and it remembers.</p>}
        </CardContent>
      </Card>

      {/* Demo workspaces */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Workspaces (demo)</CardTitle>
          <CardDescription>Try the product as a different factory — each workspace ships with its own sample data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {orgs.map((o) => (
            <div key={o.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{o.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{o.vertical}</span>
              </div>
              {current === o.slug ? (
                <Badge variant="success">current</Badge>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => seedOrg(o.slug)}>Load sample data</Button>
                  <Button size="sm" variant="outline" onClick={() => switchOrg(o.slug)}>Switch</Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
