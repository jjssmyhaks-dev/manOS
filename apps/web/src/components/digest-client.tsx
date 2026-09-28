'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Loader2Icon, SendIcon, EyeIcon } from 'lucide-react';

interface Digest {
  asOf: string;
  sections: Array<{ key: string; title: string; lines: string[] }>;
  narrative: string;
  channelDrafts: { whatsapp: string; email: string };
}

export function DigestClient() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string[] | null>(null);

  const preview = async () => {
    setBusy(true);
    try {
      const d = await fetch('/api/digest').then((r) => r.json());
      setDigest(d.digest);
    } finally {
      setBusy(false);
    }
  };

  const queue = async (channels: string[]) => {
    setBusy(true);
    try {
      await fetch('/api/digest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channels }) });
      setSent(channels);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Daily digest</h1>
          <p className="text-xs text-muted-foreground">Scheduled summary via WhatsApp/email (F3). Numbers computed from the semantic layer.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={preview} disabled={busy}>
            {busy ? <Loader2Icon className="h-4 w-4 animate-spin" /> : <EyeIcon className="h-4 w-4" />} Preview
          </Button>
          <Button onClick={() => queue(['whatsapp', 'email'])} disabled={busy || !digest}>
            <SendIcon className="h-4 w-4" /> Queue WhatsApp + email
          </Button>
        </div>
      </div>

      {sent && <div className="rounded-md border bg-emerald-50 px-3 py-2 text-xs text-emerald-700">Queued for {sent.join(' + ')}</div>}

      {digest ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">WhatsApp draft</CardTitle>
              <CardDescription>Exactly what the owner sees on the phone</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs leading-relaxed">{digest.channelDrafts.whatsapp}</pre>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Email draft</CardTitle>
              <CardDescription>Markdown email version</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="scrollbar-thin max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs leading-relaxed">{digest.channelDrafts.email}</pre>
            </CardContent>
          </Card>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Click preview to build today's digest from live metrics.</p>
      )}
    </div>
  )
};
