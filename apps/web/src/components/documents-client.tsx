'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { UploadIcon, FileCheck2Icon, Loader2Icon, CameraIcon } from 'lucide-react';

interface DocumentRow {
  id: string;
  kind: string;
  filename: string | null;
  source: string;
  status: string;
  extraction: string | null;
  confidence: number | null;
  created_at: string;
}

export function DocumentsClient() {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ confidence: number; needsReview: boolean; validation: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/documents');
    const data = await res.json();
    setDocs(data.documents ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const extract = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, filename: 'pasted-po.txt' }),
      });
      const data = await res.json();
      if (data.ok) {
        setLast({ confidence: data.overallConfidence, needsReview: data.needsReview, validation: data.validation ?? [] });
        setText('');
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const isImage = file.type.startsWith('image/');
      const fd = new FormData();
      fd.set('file', file);
      const res = await fetch(isImage ? '/api/documents/image' : '/api/documents/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.ok) {
        setLast({ confidence: data.overallConfidence, needsReview: data.needsReview, validation: data.validation ?? [] });
        await load();
      } else {
        setLast({ confidence: 0, needsReview: true, validation: [data.error ?? 'upload failed'] });
      }
    } finally {
      setBusy(false);
    }
  };

  const accept = async (id: string) => {
    setBusy(true);
    try {
      await fetch('/api/documents', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Document intake</h1>
        <p className="text-xs text-muted-foreground">
          PO/invoice/challan parsing to structured records with confidence scores and a review queue (F4).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">New document</CardTitle>
          <CardDescription>Paste PO text or upload a .txt/.csv export. PDF OCR/multimodal extraction lands with prod model keys.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'PO No: PO-7841\nDate: 2026-09-20\nFrom: Shakti Industries\nGSTIN: 29ABCDE1234F1Z5\n1. MS Bracket 200mm x 100 nos @ 240\n2. SS Enclosure 4U x 20 nos @ 1850\nTotal: 61000'}
            className="scrollbar-thin h-36 w-full rounded-md border bg-card p-3 text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex items-center gap-2">
            <Button onClick={extract} disabled={busy || !text.trim()}>
              {busy ? <Loader2Icon className="h-4 w-4 animate-spin" /> : <FileCheck2Icon className="h-4 w-4" />} Extract fields
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv,.md,.json,.pdf,image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              <UploadIcon className="h-4 w-4" /> Upload file or photo
            </Button>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <CameraIcon className="h-3 w-3" /> photos of POs/job cards need a vision model key in Settings
            </span>
            {last && (
              <span className="text-xs text-muted-foreground">
                Last: {(last.confidence * 100).toFixed(0)}% confidence · {last.needsReview ? 'needs review' : 'auto-ready'}
                {last.validation.length ? ` · ${last.validation.length} issue(s)` : ''}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Intake queue</h2>
        {docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents yet.</p>
        ) : (
          docs.map((d) => {
            const ex = d.extraction
              ? typeof d.extraction === 'string'
                ? (JSON.parse(d.extraction) as Record<string, unknown>)
                : (d.extraction as Record<string, unknown>)
              : null;
            return (
              <Card key={d.id}>
                <CardContent className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{d.filename ?? d.kind}</span>
                      <Badge variant={d.status === 'ready' ? 'success' : d.status === 'review' ? 'warning' : 'secondary'}>{d.status}</Badge>
                      <Badge variant="outline">{d.kind}</Badge>
                      <Badge variant="outline">{d.source}</Badge>
                      {d.confidence != null && <span className="text-xs text-muted-foreground">{(Number(d.confidence) * 100).toFixed(0)}%</span>}
                    </div>
                    {ex && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        PO {String(ex.poNumber ?? '—')} · {String(ex.customerName ?? '—')} · {String(ex.totalAmount ?? '—')} · {Array.isArray(ex.lines) ? `${ex.lines.length} lines` : '0 lines'}
                      </div>
                    )}
                  </div>
                  {d.status === 'review' && (
                    <Button size="sm" onClick={() => accept(d.id)}>Review & accept → SO</Button>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
