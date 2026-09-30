'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PlugIcon, RefreshCwIcon, DownloadIcon, ZapIcon, Settings2Icon, CircleCheckIcon, CircleXIcon, Loader2Icon } from 'lucide-react';

interface ConnectorRow {
  type: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  hint: string;
}

interface ActionResult {
  ok?: boolean;
  detail?: string;
  error?: string;
  pulled?: number;
  companies?: string[];
  errors?: string[];
}

const LABELS: Record<string, { title: string; desc: string }> = {
  tally: { title: 'Tally Prime', desc: 'Two-way accounting sync. Test the connection live, pull masters & vouchers, push approved vouchers straight into Tally — or run the desktop agent on the Tally machine.' },
  zoho_books: { title: 'Zoho Books', desc: 'Cloud accounting sync: contacts, items and invoices pull into the agent\u2019s data layer; approved invoices push back to Zoho.' },
  quickbooks: { title: 'QuickBooks Online', desc: 'Same sync framework as Zoho: customers, inventory items and invoices pull in; approved invoices push back to QBO.' },
  whatsapp: { title: 'WhatsApp Business', desc: 'The conversational surface: inbound questions, approvals from the phone, voice notes, digests and alerts. Credentials are platform-level.' },
  csv: { title: 'Excel / CSV import', desc: 'Upload Tally-exported or hand-made sheets; rows upsert by code (idempotent re-import).' },
  gsp: { title: 'GSP (e-invoice / e-way bill)', desc: 'Generates IRNs for B2B invoices (Collections page). Sandbox included; GSTZEN_API_KEY enables live IRN.' },
};

/** Per-type setup forms — plain-language fields, secrets masked server-side. */
function SetupForm({ type, onDone }: { type: string; onDone: (msg: { ok: boolean; text: string }) => void }) {
  const [tallyHost, setTallyHost] = useState('');
  const [tallyPort, setTallyPort] = useState('9000');
  const [tallyCompany, setTallyCompany] = useState('');
  const [zohoClientId, setZohoClientId] = useState('');
  const [zohoClientSecret, setZohoClientSecret] = useState('');
  const [zohoRefresh, setZohoRefresh] = useState('');
  const [zohoOrg, setZohoOrg] = useState('');
  const [zohoRegion, setZohoRegion] = useState('in');
  const [busy, setBusy] = useState(false);

  const call = async (action: string, config?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, type, config }),
      });
      return (await res.json()) as ActionResult;
    } finally {
      setBusy(false);
    }
  };

  if (type === 'tally') {
    return (
      <div className="mt-2 space-y-2 border-t pt-2">
        <div className="grid grid-cols-3 gap-2">
          <Input value={tallyHost} onChange={(e) => setTallyHost(e.target.value)} placeholder="Tally host (e.g. 192.168.1.50)" aria-label="Tally host" className="text-xs" />
          <Input value={tallyPort} onChange={(e) => setTallyPort(e.target.value)} placeholder="Port" aria-label="Tally port" className="text-xs" />
          <Input value={tallyCompany} onChange={(e) => setTallyCompany(e.target.value)} placeholder="Company name in Tally" aria-label="Tally company" className="text-xs" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !tallyHost || !tallyCompany} onClick={async () => {
            const r = await call('configure', { host: tallyHost, port: Number(tallyPort) || 9000, company: tallyCompany });
            if (r.ok) {
              const t = await call('test');
              onDone(t.ok ? { ok: true, text: t.detail ?? 'Connected to Tally' } : { ok: false, text: t.error ?? 'Connection failed' });
            }
          }}><Settings2Icon className="mr-1 h-3 w-3" /> Save & test</Button>
          <Button size="sm" variant="ghost" disabled={busy || !tallyHost || !tallyCompany} onClick={async () => {
            await call('configure', { host: tallyHost, port: Number(tallyPort) || 9000, company: tallyCompany });
            const r = await call('sync');
            onDone(r.ok ? { ok: true, text: `${r.detail}${r.errors?.length ? ` — ${r.errors[0]}` : ''}` } : { ok: false, text: r.error ?? r.detail ?? 'Sync failed' });
          }}><RefreshCwIcon className="mr-1 h-3 w-3" /> Save & sync now</Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Tally must be running with OLE/XML port enabled on that machine. If Tally is not network-reachable, use the desktop connector instead.
        </p>
      </div>
    );
  }

  if (type === 'quickbooks') {
    return (
      <div className="mt-2 space-y-2 border-t pt-2">
        <div className="grid grid-cols-2 gap-2">
          <Input value={zohoClientId} onChange={(e) => setZohoClientId(e.target.value)} placeholder="Client ID" aria-label="QBO client id" className="text-xs" />
          <Input type="password" value={zohoClientSecret} onChange={(e) => setZohoClientSecret(e.target.value)} placeholder="Client secret" aria-label="QBO client secret" className="text-xs" />
          <Input type="password" value={zohoRefresh} onChange={(e) => setZohoRefresh(e.target.value)} placeholder="Refresh token" aria-label="QBO refresh token" className="text-xs" />
          <Input value={zohoOrg} onChange={(e) => setZohoOrg(e.target.value)} placeholder="Company realm ID" aria-label="QBO realm id" className="text-xs" />
          <select value={zohoRegion} onChange={(e) => setZohoRegion(e.target.value)} aria-label="QBO environment" className="h-9 rounded-md border border-input bg-card px-2 text-xs">
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !zohoClientId || !zohoClientSecret || !zohoRefresh || !zohoOrg} onClick={async () => {
            const cfg = { clientId: zohoClientId, clientSecret: zohoClientSecret, refreshToken: zohoRefresh, realmId: zohoOrg, environment: zohoRegion };
            const r = await call('configure', cfg);
            if (r.ok) {
              const t = await call('test');
              onDone(t.ok ? { ok: true, text: t.detail ?? 'Connected to QuickBooks' } : { ok: false, text: t.error ?? 'Connection failed' });
            } else {
              onDone({ ok: false, text: r.error ?? 'Save failed' });
            }
          }}><Settings2Icon className="mr-1 h-3 w-3" /> Save & test</Button>
          <Button size="sm" variant="ghost" disabled={busy || !zohoClientId || !zohoClientSecret || !zohoRefresh || !zohoOrg} onClick={async () => {
            await call('configure', { clientId: zohoClientId, clientSecret: zohoClientSecret, refreshToken: zohoRefresh, realmId: zohoOrg, environment: zohoRegion });
            const r = await call('sync');
            onDone(r.ok ? { ok: true, text: r.detail ?? 'Synced' } : { ok: false, text: r.error ?? r.detail ?? 'Sync failed' });
          }}><RefreshCwIcon className="mr-1 h-3 w-3" /> Save & sync now</Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Create an Intuit app at developer.intuit.com with accounting scope, generate a refresh token for your company, and paste it here. An OAuth click-through like Zoho's can be added once the app is registered.
        </p>
      </div>
    );
  }

  if (type === 'zoho_books') {
    return (
      <div className="mt-2 space-y-2 border-t pt-2">
        <div className="grid grid-cols-2 gap-2">
          <Input value={zohoClientId} onChange={(e) => setZohoClientId(e.target.value)} placeholder="Client ID" aria-label="Zoho client id" className="text-xs" />
          <Input type="password" value={zohoClientSecret} onChange={(e) => setZohoClientSecret(e.target.value)} placeholder="Client secret" aria-label="Zoho client secret" className="text-xs" />
          <Input type="password" value={zohoRefresh} onChange={(e) => setZohoRefresh(e.target.value)} placeholder="Refresh token" aria-label="Zoho refresh token" className="text-xs" />
          <Input value={zohoOrg} onChange={(e) => setZohoOrg(e.target.value)} placeholder="Organisation ID" aria-label="Zoho organisation id" className="text-xs" />
          <select value={zohoRegion} onChange={(e) => setZohoRegion(e.target.value)} aria-label="Zoho region" className="h-9 rounded-md border border-input bg-card px-2 text-xs">
            <option value="in">India (zoho.in)</option>
            <option value="us">US (zoho.com)</option>
            <option value="eu">Europe (zoho.eu)</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !zohoClientId || !zohoClientSecret || !zohoRefresh || !zohoOrg} onClick={async () => {
            const cfg = { clientId: zohoClientId, clientSecret: zohoClientSecret, refreshToken: zohoRefresh, organizationId: zohoOrg, region: zohoRegion };
            const r = await call('configure', cfg);
            if (r.ok) {
              const t = await call('test');
              onDone(t.ok ? { ok: true, text: t.detail ?? 'Connected to Zoho Books' } : { ok: false, text: t.error ?? 'Connection failed' });
            } else {
              onDone({ ok: false, text: r.error ?? 'Save failed' });
            }
          }}><Settings2Icon className="mr-1 h-3 w-3" /> Save & test</Button>
          <Button size="sm" variant="ghost" disabled={busy || !zohoClientId || !zohoClientSecret || !zohoRefresh || !zohoOrg} onClick={async () => {
            await call('configure', { clientId: zohoClientId, clientSecret: zohoClientSecret, refreshToken: zohoRefresh, organizationId: zohoOrg, region: zohoRegion });
            const r = await call('sync');
            onDone(r.ok ? { ok: true, text: r.detail ?? 'Synced' } : { ok: false, text: r.error ?? r.detail ?? 'Sync failed' });
          }}><RefreshCwIcon className="mr-1 h-3 w-3" /> Save & sync now</Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Create a Zoho API client at api-console.zoho.com with scope ZohoBooks.fullaccess.books, generate a refresh token, and paste it here. Credentials stay on the server.
        </p>
      </div>
    );
  }

  return null;
}

export function ConnectorsClient() {
  const [rows, setRows] = useState<ConnectorRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [regInfo, setRegInfo] = useState<{ connectorId: string; deviceToken: string } | null>(null);
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [showSetup, setShowSetup] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const d = await fetch('/api/connectors').then((r) => r.json());
    setRows(d.connectors ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const call = async (type: string, action: string, extra: Record<string, unknown> = {}): Promise<ActionResult> => {
    setBusy(`${type}:${action}`);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, type, ...extra }),
      });
      return (await res.json()) as ActionResult;
    } finally {
      setBusy(null);
    }
  };

  const setMsg = (type: string, r: ActionResult) => {
    setMessages((m) => ({ ...m, [type]: { ok: Boolean(r.ok), text: r.ok ? (r.detail ?? 'Done') : (r.error ?? 'Failed') } }));
    if (r.ok) load();
  };

  const registerTally = async () => {
    setBusy('tally:register');
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'register_tally' }),
      });
      const data = await res.json();
      if (data.ok) setRegInfo({ connectorId: data.connectorId, deviceToken: data.deviceToken });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const importCsv = async () => {
    setBusy('csv:import');
    setImportMsg(null);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'import_csv', csvText }),
      });
      const data = await res.json();
      setImportMsg(data.error ?? `Imported ${data.parties ?? 0} parties, ${data.items ?? 0} items`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const order = ['tally', 'zoho_books', 'quickbooks', 'whatsapp', 'csv', 'gsp', 'gmail'];
  // union: every known connector card shows, enriched by DB state where present
  const byType = new Map(rows.map((r) => [r.type, r]));
  const catalogTypes = [...Object.keys(LABELS), ...rows.map((r) => r.type)];
  const sorted = [...new Set(catalogTypes)]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((t) => byType.get(t) ?? { type: t, status: 'disconnected', last_sync_at: null, last_error: null, hint: '' });

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Connectors</h1>
        <p className="text-xs text-muted-foreground">
          Real, tested connections to the tools your factory already uses. Test any connection live before you rely on it.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {sorted.map((c) => {
          const meta = LABELS[c.type] ?? { title: c.type, desc: '' };
          const msg = messages[c.type];
          const isDesktopTally = c.type === 'tally' && !String(c.hint).includes(':');
          return (
            <Card key={c.type}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <PlugIcon className="h-4 w-4 text-muted-foreground" /> {meta.title}
                  </CardTitle>
                  <Badge variant={c.status === 'connected' ? 'success' : c.status === 'error' ? 'destructive' : 'secondary'}>
                    {c.status === 'connected' ? 'connected' : c.status === 'error' ? 'error' : c.status === 'registered' ? 'set up, not verified' : 'not connected'}
                  </Badge>
                </div>
                <CardDescription>{meta.desc}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <div>
                  {c.last_sync_at ? `Last sync: ${new Date(c.last_sync_at).toLocaleString('en-IN')}` : 'Never synced'}
                  {c.hint ? ` · ${c.hint}` : ''}
                  {c.last_error ? <span className="text-red-600"> · {c.last_error}</span> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={async () => setMsg(c.type, await call(c.type, 'test'))}>
                    {busy === `${c.type}:test` ? <Loader2Icon className="mr-1 h-3 w-3 animate-spin" /> : <ZapIcon className="mr-1 h-3 w-3" />} Test connection
                  </Button>
                  {(c.type === 'zoho_books' || c.type === 'tally') && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={async () => setMsg(c.type, await call(c.type, 'sync'))}>
                      {busy === `${c.type}:sync` ? <Loader2Icon className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCwIcon className="mr-1 h-3 w-3" />} Sync now
                    </Button>
                  )}
                  {c.type === 'zoho_books' && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { window.location.href = '/api/connectors/zoho/connect'; }}>
                      <PlugIcon className="mr-1 h-3 w-3" /> Connect Zoho
                    </Button>
                  )}
                  {(c.type === 'tally' || c.type === 'quickbooks') && (
                    <Button size="sm" variant="ghost" onClick={() => setShowSetup((s) => ({ ...s, [c.type]: !s[c.type] }))}>
                      <Settings2Icon className="mr-1 h-3 w-3" /> {showSetup[c.type] ? 'Hide setup' : 'Connect / configure'}
                    </Button>
                  )}
                  {c.type === 'tally' && (
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={registerTally}>
                      Desktop agent token
                    </Button>
                  )}
                </div>
                {msg && (
                  <p className={`flex items-start gap-1 ${msg.ok ? 'text-emerald-600' : 'text-destructive'}`}>
                    {msg.ok ? <CircleCheckIcon className="mt-0.5 h-3 w-3 shrink-0" /> : <CircleXIcon className="mt-0.5 h-3 w-3 shrink-0" />} {msg.text}
                  </p>
                )}
                {c.type === 'whatsapp' && (
                  <p className="text-[11px]">Platform-level: the operator sets WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID; owners just add their number in Settings.</p>
                )}
                {isDesktopTally && (
                  <p className="text-[11px]">Running on the Tally machine? &ldquo;Desktop agent token&rdquo; gives you a one-line env setup instead of network access.</p>
                )}
                {showSetup[c.type] && <SetupForm type={c.type} onDone={(m) => setMessages((ms) => ({ ...ms, [c.type]: m }))} />}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {regInfo && (
        <Card className="border-amber-400">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm">Desktop connector credentials — shown once</CardTitle>
            <CardDescription>
              Set these on the machine running Tally Prime, then start the connector. It heartbeats every 30s, pulls masters and pushes approved vouchers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 font-mono text-xs">
            <div>FACTORY_API=http://localhost:3100</div>
            <div>FACTORY_CONNECTOR_ID={regInfo.connectorId}</div>
            <div>FACTORY_DEVICE_TOKEN={regInfo.deviceToken}</div>
            <div>FACTORY_COMPANY=&quot;Your Company Name&quot;</div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">CSV import (idempotent)</CardTitle>
          <CardDescription>
            Headers accepted: code, name, kind, qty/stock on hand, rate, gstin, reorder point, reorder qty, uom, date.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={'code,name,kind,gstin,qty,rate,reorder point,uom\nP-001,Shakti Industries,vendor,29ABCDE1234F1Z5,,,\nP-002,Sundaram Traders,customer,29AQWRT1234F1Z2,,,\nI-001,MS Bracket 200mm,item,,340,240,150,nos'}
            className="scrollbar-thin h-28 w-full rounded-md border bg-card p-3 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex items-center gap-2">
            <Button onClick={importCsv} disabled={busy !== null || !csvText.trim()}>
              {busy === 'csv:import' ? <Loader2Icon className="h-4 w-4 animate-spin" /> : <DownloadIcon className="h-4 w-4" />} Import
            </Button>
            {importMsg && <span className="text-xs text-muted-foreground">{importMsg}</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
