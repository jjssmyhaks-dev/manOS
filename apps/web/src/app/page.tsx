import Link from 'next/link';
import { ArrowRight, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Marketing landing page — design language borrowed from the HyperComply
 * landing (hero + email capture, logo marquee, deep-brand feature bands,
 * quote CTA), re-imagined for the Factory AI OS product story.
 */

const NAV = [
  { href: '#product', label: 'Product' },
  { href: '#packs', label: 'Vertical packs' },
  { href: '#governance', label: 'Governance' },
  { href: '#learn', label: 'Learn more' },
  { href: '#why', label: 'Why Factory?' },
];

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="Factory AI OS home">
      <svg viewBox="0 0 32 32" className="h-8 w-8 fill-brand-deep" aria-hidden="true">
        <path d="M4 26V12l6 4v-6l6 4V6l12 8v12H4Z" />
      </svg>
      <span className="text-[22px] font-semibold tracking-tight text-brand-deep">Factory AI OS</span>
    </Link>
  );
}

const LOGOS = ['Tally', 'Zoho Books', 'Excel', 'Marg ERP', 'Busy', 'Focus ERP', 'GSP/e-invoice', 'WhatsApp'];

/** Static mock of the agent UI (no screenshots needed — it's real UI). */
function AgentPreview() {
  return (
    <div className="w-full max-w-[560px] rounded-lg border border-border bg-card shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-primary/70" />
        <span className="text-sm font-semibold text-brand-deep">Ask your factory</span>
        <span className="ml-auto rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Precision Metalworks · fabrication</span>
      </div>
      <div className="space-y-3 px-4 py-4 text-sm">
        <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-primary-foreground">
          Is 20mm bracket in stock? And what&apos;s overdue?
        </div>
        <div className="rounded-lg border border-border bg-background/70 px-3 py-1.5 text-xs text-muted-foreground">
          🔧 <span className="font-medium text-foreground">list_overdue</span> · 🔧 <span className="font-medium text-foreground">get_item_stock</span>
          <span className="ml-1">· running on your data</span>
        </div>
        <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 leading-relaxed">
          <p className="font-medium text-brand-deep">MS Bracket 20mm: 140 nos on hand — healthy.</p>
          <p className="mt-1">22 overdue invoices, ₹29.18 L. Top: Iyer Works ₹1.7 L (70d), Sharma Enterprises ₹2.6 L (46d).</p>
          <p className="mt-1 text-muted-foreground">Draft payment reminders?</p>
        </div>
        <div className="flex gap-2 pt-1">
          <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">Overdue &gt; 45 days</span>
          <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">This month sales</span>
          <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">Low stock</span>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main id="top" className="min-h-screen overflow-hidden bg-background text-foreground">
      <a href="#product" className="block bg-banner px-4 py-2.5 text-center text-sm font-semibold underline underline-offset-2 text-brand-deep">
        📣 Built for Indian MSME factories — Tally, Excel and WhatsApp first. Works in English, Hindi and Hinglish → Open the live demo
      </a>

      <header className="relative mx-auto flex h-[98px] max-w-[1110px] items-center justify-between px-6">
        <Brand />
        <nav className="hidden items-center gap-10 text-[14px] font-medium lg:flex" aria-label="Main navigation">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className="hover:opacity-65">{n.label}</a>
          ))}
        </nav>
        <div className="hidden items-center gap-7 lg:flex">
          <Link href="/chat" className="text-sm font-medium">Sign in</Link>
          <Button variant="demo" size="demo" asChild>
            <Link href="/chat">Open the factory agent</Link>
          </Button>
        </div>
      </header>

      {/* hero */}
      <section className="mx-auto grid min-h-[560px] max-w-[1110px] items-center gap-12 px-6 pb-10 pt-14 lg:grid-cols-[46%_54%] lg:pt-4">
        <div className="relative z-10 min-w-0">
          <h1 className="max-w-[520px] text-[40px] font-normal leading-[1.1] text-brand-deep md:text-[54px]">
            Run your factory on an AI operations layer
          </h1>
          <p className="mt-5 max-w-[510px] text-[16px] leading-6 text-muted-foreground">
            Factory AI OS reads the tools your factory already runs — Tally, Excel, weighbridge,
            WhatsApp — and turns them into an agent you can ask: sales, stock, receivables,
            production, procurement. Every number comes from your data, every action goes
            through your approval policy.
          </p>
          <form
            className="mt-5 grid w-full max-w-full grid-cols-[minmax(0,1fr)] gap-2 sm:max-w-[470px] sm:grid-cols-[minmax(0,1fr)_auto]"
            action="/chat"
          >
            <Input
              aria-label="Work email"
              type="email"
              name="email"
              placeholder="Enter Your Work Email"
              className="h-12 min-w-0 rounded border-border bg-card px-4 shadow-none"
            />
            <Button variant="demo" size="demo" type="submit" className="w-full sm:w-auto">Request A Demo</Button>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            Demo environment seeds a full fabrication factory — no signup, no card.
          </p>
        </div>
        <div className="relative min-w-0 lg:-mr-20 lg:translate-x-4">
          <AgentPreview />
        </div>
      </section>

      {/* logo marquee */}
      <section aria-label="Connects with" className="py-14">
        <p className="mb-6 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Connects with the stack Indian factories already run
        </p>
        <div className="relative overflow-hidden">
          <div className="logo-track flex w-max items-center">
            {[...LOGOS, ...LOGOS].map((name, i) => (
              <div key={`${name}-${i}`} className="flex h-14 w-[190px] shrink-0 items-center justify-center px-8">
                <span className="whitespace-nowrap text-lg font-semibold text-brand-deep/50">{name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* product band 1 — deep brand */}
      <section id="product" className="bg-brand-deep py-24 text-primary-foreground">
        <div className="mx-auto max-w-[1110px] px-6">
          <h2 className="max-w-3xl text-4xl font-normal leading-tight md:text-5xl">
            One agent across sales, stock, receivables and the shop floor
          </h2>
          <div className="mt-14 grid items-center gap-14 lg:grid-cols-2">
            <div className="rounded-lg border border-white/15 bg-white/5 p-6 shadow-2xl backdrop-blur">
              <div className="grid grid-cols-2 gap-4 text-sm">
                {[
                  ['Sales (30d)', '₹15.59 L'],
                  ['Overdue', '₹58.35 L · 44 inv'],
                  ['Low stock', '2 items'],
                  ['Delayed orders', '20'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-md border border-white/10 bg-background/90 p-4">
                    <div className="text-xs text-muted-foreground">{k}</div>
                    <div className="mt-1 text-xl font-semibold text-brand-deep">{v}</div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs opacity-70">Live KPIs from the seeded demo org — not a screenshot.</p>
            </div>
            <div>
              <p className="text-sm font-semibold uppercase opacity-80">Operations copilot</p>
              <h3 className="mt-3 text-3xl font-normal">Answers with sources, drafts with approvals</h3>
              <p className="mt-5 text-lg leading-8 opacity-80">
                The agent plans tool calls over a semantic metric layer — never inventing figures —
                then drafts reminders, RFQs and purchase orders that route through your
                auto / ask / deny policy before anything leaves the building.
              </p>
              <Link href="/chat" className="mt-7 inline-flex items-center gap-2 font-semibold">
                Try the agent <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* product band 2 — documents */}
      <section id="packs" className="mx-auto grid max-w-[1110px] items-center gap-14 px-6 py-24 lg:grid-cols-2">
        <div>
          <p className="text-sm font-semibold uppercase text-muted-foreground">Document intake</p>
          <h2 className="mt-3 text-4xl font-normal leading-tight">POs to sales orders, with a review queue</h2>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            Paste or upload a PO and the extraction agent parses lines, GSTIN and amounts with
            per-field confidence, flags what needs human review, and creates the sales order
            through the policy engine. WhatsApp voice notes flow through the same pipeline.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-6 shadow-xl">
          <div className="space-y-2 text-sm">
            {[
              ['PO-7841 · Shakti Industries', 'ready', '99%'],
              ['PO-7844 · Deccan Traders', 'review', '62%'],
              ['INV-118 · Kirloskar Sales', 'ready', '96%'],
            ].map(([name, status, conf]) => (
              <div key={name} className="flex items-center justify-between rounded-md border border-border px-4 py-3">
                <span className="font-medium">{name}</span>
                <span className="flex items-center gap-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 ${status === 'ready' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{status}</span>
                  <span className="text-muted-foreground">{conf}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* vertical packs strip */}
      <section className="bg-brand-soft px-6 py-20">
        <div className="mx-auto max-w-[1110px]">
          <p className="text-center text-sm font-semibold uppercase">Configuration, not forks</p>
          <h2 className="mx-auto mt-4 max-w-3xl text-center text-3xl font-normal leading-tight md:text-4xl">
            Four vertical packs ship out of the box
          </h2>
          <div className="mt-12 grid gap-5 md:grid-cols-4">
            {[
              ['Fabrication / job-shop', 'OTIF %, scrap %, WIP value, job-card yield'],
              ['FMCG / foods', 'batch expiry, FEFO, scheme claims, distributor stock'],
              ['Scrap & recycling', 'weighbridge yield, grade-wise rates, party limits'],
              ['Exports', 'shipping docs, LUT/IEC tracking, FX exposure view'],
            ].map(([title, body]) => (
              <div key={title} className="rounded-lg border border-border bg-card p-5 shadow-sm">
                <h3 className="font-semibold text-brand-deep">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* governance */}
      <section id="governance" className="mx-auto max-w-[1110px] px-6 py-24">
        <div className="grid gap-10 lg:grid-cols-3">
          {[
            ['Approval policy engine', 'Every agent write — POs, reminders, RFQs — resolves auto-execute, approvals inbox, or blocked. Full audit trail, always.'],
            ['Guardrails built in', 'Role allowlists on tools, PII redaction, and prompt-injection isolation for untrusted document text.'],
            ['Observability', 'Traces, token metering and an audit log for every agent run — the owner sees what the AI did and why.'],
          ].map(([title, body]) => (
            <div key={title}>
              <h3 className="text-xl font-semibold text-brand-deep">{title}</h3>
              <p className="mt-3 leading-7 text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* quote CTA */}
      <section id="why" className="bg-brand-soft px-6 py-24 text-center">
        <p className="text-sm font-semibold uppercase">What factory owners are saying</p>
        <h2 className="mx-auto mt-6 max-w-4xl text-4xl font-normal leading-tight md:text-5xl text-brand-deep">
          “Overdue collections used to take my evenings. Now the agent reminds them before I even ask.”
        </h2>
        <Button variant="demo" size="demo" className="mt-9" asChild>
          <Link href="/chat"><Play className="h-4 w-4 fill-current" /> Open the live factory</Link>
        </Button>
      </section>

      <footer id="learn" className="border-t border-border bg-background px-6 py-14">
        <div className="mx-auto flex max-w-[1110px] flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <Brand />
          <nav className="flex flex-wrap items-center gap-8 text-sm text-muted-foreground" aria-label="Footer">
            <Link href="/chat" className="hover:text-foreground">Live demo</Link>
            <Link href="/dashboard" className="hover:text-foreground">Dashboard</Link>
            <Link href="/documents" className="hover:text-foreground">Documents</Link>
            <Link href="/audit" className="hover:text-foreground">Audit log</Link>
          </nav>
          <p className="text-xs text-muted-foreground">© 2026 Factory AI OS · Made for Indian manufacturing</p>
        </div>
      </footer>
    </main>
  );
}
