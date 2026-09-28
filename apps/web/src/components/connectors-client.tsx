'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PlugIcon, RefreshCwIcon, DownloadIcon } from 'lucide-react';

interface ConnectorRow {
  type: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
}

const LABELS: Record<string, { title: string; desc: string }> = {
  tally: { title: 'Tally Prime (live two-way sync)', desc: 'Desktop connector (apps/connector-desktop) → outbound HTTPS with device token. XML-over-HTTP pull/push per C-4.' },
  csv: { title: 'Excel / CSV import', desc: 'Upload Tally-exported or hand-made sheets; rows upsert by code (idempotent re-import).' },
  whatsapp: { title: 'WhatsApp Business Cloud', desc: 'Webhooks + templates; set WHATSAPP_APP_SECRET to enforce signatures.' },
  gmail: { title: 'Email (Gmail/Outlook)', desc: 'OAuth + polling in prod; PO/invoice emails flow into document intake.' },
  gsp: { title: 'GSP (e-invoice / e-way bill)', desc: 'Provider interface with GSTZen/MasterGST/WhiteBooks sandboxes (C-3).' },
};

export function ConnectorsClient() {
  const [rows, setRows] = useState<ConnectorRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [regInfo, setRegInfo] = useState<{ connectorId: string; deviceToken: string } | null>(null);

  const registerTally = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'register_tally' }),
      });
      const data = await res.json();
      if (data.ok) setRegInfo({ connectorId: data.connectorId, deviceToken: data.deviceToken });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(async () => {
    const d = await fetch('/api/connectors').then((r) => r.json());
    setRows(d.connectors ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const importCsv = async () => {
    setBusy(true);
    setImportMsg(null);
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'import_csv', csv: csvText }),
      });
      const data = await res.json();
      setImportMsg(data.error ?? `Imported ${data.parties ?? 0} parties, ${data.items ?? 0} items`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Connectors</h1>
        <p className="text-xs text-muted-foreground">Connector health and setup (F1). Every connector implements auth/sync/read/write/webhookHandler/health.</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {(rows.length ? rows : Object.keys(LABELS).map((t) => ({ type: t, status: 'disconnected', last_sync_at: null, last_error: null }))).map((c) => {
          const meta = LABELS[c.type] ?? { title: c.type, desc: '' };
          return (
            <Card key={c.type}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <PlugIcon className="h-4 w-4 text-muted-foreground" /> {meta.title}
                  </CardTitle>
                  <Badge variant={c.status === 'connected' ? 'success' : c.status === 'error' ? 'destructive' : 'secondary'}>{c.status}</Badge>
                </div>
                <CardDescription>{meta.desc}</CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {c.last_sync_at ? `Last sync: ${new Date(c.last_sync_at).toLocaleString('en-IN')}` : 'Never synced'}
                {c.last_error ? <span className="text-red-600"> · {c.last_error}</span> : null}
                {c.type === 'tally' && (
                  <div className="mt-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={registerTally}>
                      {c.status === 'registered' || c.status === 'connected' ? 'Rotate token' : 'Register desktop connector'}
                    </Button>
                  </div>
                )}
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
            placeholder={'code,name,kind,gstin,qty,rate,reorder point,uom\nP-001,Shakti Industries,vendor,29ABCDE1234F1Z5,,, \nP-002,Sundaram Traders,customer,29AQWRT1234F1Z2,,,\nI-001,MS Bracket 200mm,item,,340,240,150,nos'}
            className="scrollbar-thin h-28 w-full rounded-md border bg-card p-3 font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex items-center gap-2">
            <Button onClick={importCsv} disabled={busy || !csvText.trim()}>
              {busy ? <RefreshCwIcon className="h-4 w-4 animate-spin" /> : <DownloadIcon className="h-4 w-4" />} Import
            </Button>
            {importMsg && <span className="text-xs text-muted-foreground">{importMsg}</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
