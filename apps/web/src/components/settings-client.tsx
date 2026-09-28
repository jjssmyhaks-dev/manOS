'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface PolicyRow { action_type: string; decision: 'auto' | 'ask' | 'deny' }
interface FactRow { id: string; fact: string; status: string; source: string }

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

  const load = useCallback(async () => {
    const s = await fetch('/api/settings').then((r) => r.json());
    setPolicies(s.policies ?? []);
    setFacts(s.facts ?? []);
    const o = await fetch('/api/org').then((r) => r.json());
    setOrgs(o.orgs ?? []);
    setCurrent(o.session?.orgSlug ?? null);
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
                <Badge variant="outline">{f.source}</Badge>
                <Button size="sm" variant="ghost" onClick={() => archiveFact(f.id)}>Archive</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
