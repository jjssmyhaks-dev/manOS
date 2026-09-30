'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2Icon, CircleIcon, EyeIcon, ListChecksIcon, XIcon } from 'lucide-react';

/**
 * Guided pilot onboarding (PRD v2): every new workspace starts in shadow mode
 * with a 3-step setup checklist — WhatsApp number, GSTIN, Tally/Zoho/QuickBooks.
 * Steps re-check live from the API on every mount, so completing a step in
 * Settings/Connectors ticks the card on the next dashboard visit.
 */

interface Step {
  key: string;
  label: string;
  hint: string;
  href: string;
  done: boolean;
}

interface Status {
  orgName: string;
  shadowMode: boolean;
  steps: Step[];
  doneCount: number;
  completedAt: string | null;
}

export function OnboardingChecklist() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch('/api/onboarding')
      .then((r) => r.json())
      .then((d: Status) => setStatus(d))
      .catch(() => setStatus(null));
  }, []);

  if (!status || dismissed) return null;
  const allDone = status.doneCount === status.steps.length;

  const dismiss = async () => {
    setDismissed(true);
    await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'complete' }),
    });
  };

  return (
    <div className={`rounded-lg border p-4 ${allDone ? 'border-emerald-200 bg-emerald-50' : 'bg-card'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListChecksIcon className={`h-4 w-4 ${allDone ? 'text-emerald-600' : 'text-primary'}`} />
          <div>
            <div className="text-sm font-semibold">
              {allDone ? 'Setup complete — welcome aboard!' : `Set up ${status.orgName} (${status.doneCount}/${status.steps.length})`}
            </div>
            {!allDone && (
              <div className="text-xs text-muted-foreground">Three quick steps to make the assistant truly yours.</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status.shadowMode && (
            <span className="flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-800">
              <EyeIcon className="h-3 w-3" /> Shadow mode: drafts only, nothing executes
            </span>
          )}
          <button
            onClick={dismiss}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
            aria-label="Hide the setup checklist"
          >
            <XIcon className="h-3 w-3" /> Hide
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {status.steps.map((step, i) => (
          <Link
            key={step.key}
            href={step.href}
            className={`flex items-start gap-2 rounded-md border p-3 transition-colors ${
              step.done ? 'border-emerald-200 bg-emerald-50/60' : 'hover:bg-muted/50'
            }`}
          >
            {step.done ? (
              <CheckCircle2Icon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <CircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="block text-xs font-medium">
                {i + 1}. {step.label}
              </span>
              <span className="block text-[11px] text-muted-foreground">{step.done ? 'Done ✓' : step.hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
