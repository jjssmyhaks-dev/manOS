'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface PolicyRow { action_type: string; decision: 'auto' | 'ask' | 'deny' }
interface FactRow { id: string; fact: string; status: string; source: string }
interface AiConfig {
  provider: string;
  model_route: 'default' | 'budget';
  has_org_key: boolean;
  key_masked: string | null;
  has_env_key: boolean;
  effective: string;
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
  send_reminder: 'Send payment reminders',
  send_rfq: 'Send RFQs to vendors',
  create_po: 'Create purchase orders',
  so_create: 'Create sales orders',
  tally_push: 'Push vouchers to Tally',
  digest_send: 'Send digests',
  whatsapp_send: 'Send WhatsApp messages',
  email_send: 'Send emails',
  grn_create: 'Post GRNs',
  job_card_update: 'Update job cards',
};

export function SettingsClient() {
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [newFact, setNewFact] = useState('');
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; slug: string; vertical: string }>>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [ai, setAi] = useState<AiConfig | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
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
    setAi(s.ai ?? null);
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

  const saveAiConfig = async () => {
    setAiMsg(null);
    const body: Record<string, unknown> = { action: 'set_ai_config' };
    if (apiKeyInput.trim()) body.apiKey = apiKeyInput.trim();
    if (ai?.model_route) body.modelRoute = ai.model_route;
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setAiMsg(res.ok && data.ok ? { ok: true, text: 'Saved — the agent now runs on OpenRouter.' } : { ok: false, text: data.error ?? 'Save failed' });
    setApiKeyInput('');
    await load();
  };

  const clearAiKey = async () => {
    await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear_ai_key' }),
    });
    setAiMsg({ ok: true, text: 'Org key removed — falling back to env or the mock model.' });
    await load();
  };

  const saveNotify = async () => {
    setNotifyMsg(null);
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save_notify', ownerPhone: phoneInput.trim() || null, autoSend }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setNotifyMsg(res.ok && data.ok ? { ok: true, text: 'Saved — digests and reminders will go to this number.' } : { ok: false, text: data.error ?? 'Save failed' });
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
        : { ok: true, text: `Dispatched: ${d.processed ?? 0} queued · ${d.sent ?? 0} sent · ${d.echoed ?? 0} echoed (dev) · ${d.failed ?? 0} failed.` }
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
      setJobMsg({ ok: true, text: 'Task scheduled — the agent runs it with the daily cron.' });
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
        ? { ok: true, text: `Ran — reply delivered${d.notified ? ' to WhatsApp queue' : ''}: “${(d.reply ?? '').slice(0, 90)}…”` }
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
        <p className="text-xs text-muted-foreground">Approval policy engine, org memory, workspace (F1 + harness layer).</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">AI model (OpenRouter)</CardTitle>
          <CardDescription>
            Paste an OpenRouter API key to run the agent on a real model. Keys are stored server-side per org and never sent back to the browser. Without a key the app runs the offline deterministic mock.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={ai?.has_org_key || ai?.has_env_key ? 'success' : 'outline'}>
              {ai?.effective ?? 'loading…'}
            </Badge>
            {ai?.key_masked && <span className="font-mono text-xs text-muted-foreground">{ai.key_masked}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="sk-or-v1-…"
              className="max-w-xs font-mono text-xs"
              aria-label="OpenRouter API key"
              autoComplete="off"
            />
            <select
              value={ai?.model_route ?? 'default'}
              onChange={(e) => setAi((a) => (a ? { ...a, model_route: e.target.value as 'default' | 'budget' } : a))}
              className="h-9 rounded-md border border-input bg-card px-2 text-xs"
              aria-label="Model route"
            >
              <option value="default">default — gpt-4o class</option>
              <option value="budget">budget — flash/sonnet class</option>
            </select>
            <Button size="sm" onClick={saveAiConfig} disabled={!apiKeyInput.trim() && !ai}>Save</Button>
            {ai?.has_org_key && (
              <Button size="sm" variant="ghost" onClick={clearAiKey}>Remove key</Button>
            )}
          </div>
          {aiMsg && <p className={`text-xs ${aiMsg.ok ? 'text-emerald-600' : 'text-destructive'}`}>{aiMsg.text}</p>}
          <p className="text-xs text-muted-foreground">
            Route picks the model class: default uses gpt-4o for reasoning and gpt-4o-mini for extraction; budget uses cheaper models.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">WhatsApp delivery</CardTitle>
          <CardDescription>
            Where digests, payment reminders and approval alerts land. Without Cloud API credentials the app runs in echo mode — sends are recorded and audited but not delivered.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={notify?.mode === 'live' ? 'success' : 'warning'}>
              {notify ? (notify.mode === 'live' ? 'Cloud API live' : 'echo mode (dev)') : 'loading…'}
            </Badge>
            {notify?.mode === 'echo' && (
              <span className="text-xs text-muted-foreground">set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID env vars for real delivery</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="Owner number, e.g. 919812345678"
              className="max-w-xs font-mono text-xs"
              aria-label="Owner WhatsApp number"
              autoComplete="off"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
              auto-send with daily cron
            </label>
            <Button size="sm" onClick={saveNotify} disabled={!notify}>Save</Button>
            <Button size="sm" variant="outline" onClick={dispatchNow} disabled={!notify}>Dispatch queued now</Button>
          </div>
          {notifyMsg && <p className={`text-xs ${notifyMsg.ok ? 'text-emerald-600' : 'text-destructive'}`}>{notifyMsg.text}</p>}
          <p className="text-xs text-muted-foreground">
            The agent also answers questions that arrive from this number — the owner's WhatsApp is a full chat surface.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Agent tasks (recurring, in plain language)</CardTitle>
          <CardDescription>
            Tell the agent what to do repeatedly — it runs with the daily cron, uses its tools, and sends you the outcome on WhatsApp.
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
              <option value="daily">daily</option>
              <option value="weekly:1">every Monday</option>
              <option value="weekly:2">every Tuesday</option>
              <option value="weekly:3">every Wednesday</option>
              <option value="weekly:4">every Thursday</option>
              <option value="weekly:5">every Friday</option>
              <option value="weekly:6">every Saturday</option>
              <option value="weekly:7">every Sunday</option>
            </select>
            <Input
              value={jobInstruction}
              onChange={(e) => setJobInstruction(e.target.value)}
              placeholder="e.g. chase every invoice overdue more than 15 days and tell me the total"
              className="min-w-64 flex-1 text-xs"
              aria-label="Agent task instruction"
            />
            <Button size="sm" onClick={addJob} disabled={!jobInstruction.trim()}>Schedule</Button>
          </div>
          {jobMsg && <p className={`text-xs ${jobMsg.ok ? 'text-emerald-600' : 'text-destructive'}`}>{jobMsg.text}</p>}
          {jobs.map((j) => (
            <div key={j.id} className="rounded-md border px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <Badge variant="outline">{j.schedule === 'daily' ? 'daily' : j.schedule.replace('weekly:', 'every ')}</Badge>{' '}
                  <span className="font-medium">{j.instruction}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" onClick={() => runJobNow(j.id)}>Run now</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggleJob(j.id, !j.enabled)}>{j.enabled ? 'Pause' : 'Resume'}</Button>
                </div>
              </div>
              <div className="mt-1 text-muted-foreground">
                {j.last_result?.running
                  ? 'running…'
                  : j.last_run_at
                    ? `last run ${new Date(j.last_run_at).toLocaleString('en-IN')} — ${String((j.last_result as { reply?: string })?.reply ?? '').slice(0, 80)}`
                    : 'never run — the daily cron will pick it up'}
              </div>
            </div>
          ))}
          {jobs.length === 0 && <p className="text-xs text-muted-foreground">No scheduled tasks yet.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Demo orgs (vertical packs)</CardTitle>
          <CardDescription>Switch workspace — each org is a different vertical pack configuration.</CardDescription>
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
                  <Button size="sm" variant="outline" onClick={() => seedOrg(o.slug)}>Seed data</Button>
                  <Button size="sm" variant="outline" onClick={() => switchOrg(o.slug)}>Switch</Button>
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Seeding replaces demo data for that org slug.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Approval policies</CardTitle>
          <CardDescription>auto = execute immediately · ask = approvals inbox · deny = blocked. Outbound defaults to ask.</CardDescription>
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
                    {d}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {policies.length === 0 && <p className="text-sm text-muted-foreground">No policies configured yet.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Org memory (reviewable facts)</CardTitle>
          <CardDescription>Agent-visible facts about how your factory runs — reviewable, not hidden prompt state.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input value={newFact} onChange={(e) => setNewFact(e.target.value)} placeholder="e.g. Always quote rates excluding GST" />
            <Button onClick={addFact}>Add</Button>
          </div>
          {facts.map((f) => (
            <div key={f.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>{f.fact}</span>
              <div className="flex items-center gap-2">
                <Badge variant={f.source === 'agent' ? 'success' : 'outline'}>{f.source === 'agent' ? 'learned in chat' : f.source}</Badge>
                <Button size="sm" variant="ghost" onClick={() => archiveFact(f.id)}>Archive</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
