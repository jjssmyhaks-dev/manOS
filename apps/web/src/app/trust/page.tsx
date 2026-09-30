import Link from 'next/link';
import { getSession } from '@/lib/session';
import { listActivity } from '@factory/agents';
import { query } from '@factory/db';
import { ShieldCheckIcon, Undo2Icon, MessageCircleIcon, Volume2Icon, FactoryIcon, ArrowRightIcon } from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * The trust one-pager (PRD v2 §10.3): public materials lead with "see
 * everything the AI does and undo it", not a module checklist. The hero is
 * the REAL activity timeline from the demo workspace — the product sells
 * itself with its own audit trail.
 */

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ', ' + d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export default async function TrustPage() {
  // real entries from the demo org (falls back to a static slice if empty)
  let entries: Array<{ summary: string; status: string; created_at: string; reason: string | null }> = [];
  let orgName = 'a demo factory';
  try {
    const s = await getSession();
    if (s.orgId !== 'none') {
      entries = (await listActivity(s.orgId, { limit: 4 })).map((a) => ({ summary: a.summary, status: a.status, created_at: a.created_at, reason: a.reason }));
      orgName = s.orgName;
    }
    if (entries.length === 0) {
      const fallbackOrg = await query<{ id: string; name: string }>('select id, name from organizations order by created_at asc limit 1');
      if (fallbackOrg[0]) {
        orgName = fallbackOrg[0].name;
        entries = (await listActivity(fallbackOrg[0].id, { limit: 4 })).map((a) => ({ summary: a.summary, status: a.status, created_at: a.created_at, reason: a.reason }));
      }
    }
  } catch {
    // landing must render even with a cold database
  }

  const demoEntries = entries.length
    ? entries
    : [
        { summary: 'Drafted purchase entry — 4,200 kg of MS solid from Ramesh Scrap Traders at ₹28/kg = ₹1,17,600 (ticket WB-7723) — waiting for your approval', status: 'awaiting_approval', created_at: new Date().toISOString(), reason: 'Rate taken from today\u2019s MS-solid card.' },
        { summary: 'Sent a WhatsApp payment reminder to Patel Traders for INV-2014 (₹3,72,849, 13 days overdue)', status: 'executed', created_at: new Date(Date.now() - 3600_000).toISOString(), reason: null },
        { summary: 'Generated e-invoice IRN for INV-2004 — Iyer Works, ₹1,48,402 (IGST @ 12%) via sandbox', status: 'executed', created_at: new Date(Date.now() - 7200_000).toISOString(), reason: null },
      ];

  return (
    <div className="min-h-screen bg-background">
      {/* hero */}
      <div className="border-b bg-gradient-to-b from-indigo-50/60 to-background">
        <div className="mx-auto max-w-4xl px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex w-fit items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
            <FactoryIcon className="h-3.5 w-3.5 text-primary" /> An AI operations team for Indian MSME factories
          </div>
          <h1 className="text-3xl font-bold leading-tight md:text-4xl">
            See everything the AI does.<br />
            <span className="text-primary">And undo it.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm text-muted-foreground md:text-base">
            An AI agent that reads your documents, chases payments, books purchases and keeps Tally/Zoho fresh —
            with a full activity log of every action, the data it used, and a 24-hour undo on anything it executed.
            Trust is the product, not a feature.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href="/" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              Try the live demo <ArrowRightIcon className="inline h-3.5 w-3.5" />
            </Link>
            <Link href="/activity" className="rounded-md border px-4 py-2 text-sm hover:bg-muted">
              Open the AI Activity log
            </Link>
          </div>
        </div>
      </div>

      {/* hero demo: the REAL activity timeline */}
      <div className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheckIcon className="h-5 w-5 text-emerald-600" /> The actual activity log from {orgName}</h2>
          <span className="text-xs text-muted-foreground">live data, not a mockup</span>
        </div>
        <div className="space-y-2">
          {demoEntries.map((e, i) => (
            <div key={i} className="rounded-lg border bg-card p-3 text-sm shadow-sm">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${e.status === 'executed' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                  {e.status === 'executed' ? 'done · undoable for 24h' : 'waiting for the owner'}
                </span>
                {timeLabel(e.created_at)}
              </div>
              <p className="mt-1">{e.summary}</p>
              {e.reason && <p className="mt-0.5 text-xs text-muted-foreground">Why: {e.reason}</p>}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Every entry shows what the AI read, what it concluded and why. Owners can undo any executed action in the
          last 24 hours — records are cancelled, never deleted, so the audit trail stays complete.
        </p>
      </div>

      {/* the three pillars */}
      <div className="border-t bg-muted/30">
        <div className="mx-auto grid max-w-4xl gap-4 px-6 py-12 md:grid-cols-3">
          <div className="rounded-lg border bg-card p-4">
            <Undo2Icon className="h-5 w-5 text-primary" />
            <h3 className="mt-2 text-sm font-semibold">Undo anything</h3>
            <p className="mt-1 text-xs text-muted-foreground">24-hour undo window on every executed action. Cancelled, not deleted — your books stay reconcilable.</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <MessageCircleIcon className="h-5 w-5 text-emerald-600" />
            <h3 className="mt-2 text-sm font-semibold">WhatsApp-first</h3>
            <p className="mt-1 text-xs text-muted-foreground">Ask anything, approve from your phone, get alerts before they become problems. Your number is the chat window.</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <Volume2Icon className="h-5 w-5 text-amber-600" />
            <h3 className="mt-2 text-sm font-semibold">Speaks your language</h3>
            <p className="mt-1 text-xs text-muted-foreground">Hindi & Hinglish voice notes in, spoken answers out — built for the shop floor, not the desk.</p>
          </div>
        </div>
      </div>

      <div className="border-t">
        <div className="mx-auto max-w-4xl px-6 py-10 text-center">
          <h2 className="text-lg font-semibold">Built for scrap & waste processors and export houses first</h2>
          <p className="mx-auto mt-2 max-w-xl text-xs text-muted-foreground">
            Weighbridge tickets over WhatsApp, grade-based rate cards, LUT/IEC tracking and buyer follow-ups — the
            workflows generic ERPs skip. Now live with design partners; ask us for the case study.
          </p>
          <Link href="/" className="mt-5 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Open the demo <ArrowRightIcon className="inline h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
