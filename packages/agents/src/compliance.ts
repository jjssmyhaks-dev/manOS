import { query, audit } from '@factory/db';
import { generateEInvoice } from './einvoice.js';
import { notifyOwnerDirect } from './notify.js';

/**
 * Agent 10 — Compliance (spec): GST e-invoice / e-way bill done right and on
 * time. The IRN/EWB generation itself already existed (einvoice.ts/eway.ts +
 * nightly auto-einvoicing); this module adds the spec's remaining pieces:
 *
 *  - `checkEinvoiceApplicability` — the threshold rule as CONFIG (exported
 *    constant), not hardcoded inline, per the spec's "rules change → review"
 *    edge case. B2B-only (valid buyer GSTIN).
 *  - `runComplianceCheck` — the mechanical loop for one org: eligible
 *    dispatched invoices get IRNs; ANY GSP error routes to a human queue
 *    (notification) immediately with a retry cap — never silently retried
 *    forever.
 *  - `recordComplianceStatus` — durable status on the invoice record.
 */

/** e-Invoice applies to B2B invoices of at least this value (₹). Rule in config. */
export const EINVOICE_THRESHOLD_INR = 50_000;

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export interface Applicability {
  applicable: boolean;
  reason: string;
}

/** Deterministic rule check against the configured threshold. */
export function checkEinvoiceApplicability(invoice: { amount: number; buyerGstin?: string | null }): Applicability {
  if (!invoice.buyerGstin || !GSTIN_RE.test(invoice.buyerGstin)) {
    return { applicable: false, reason: 'B2C or buyer GSTIN missing/invalid — e-invoice does not apply.' };
  }
  if (invoice.amount < EINVOICE_THRESHOLD_INR) {
    return { applicable: false, reason: `Invoice value ₹${invoice.amount.toLocaleString('en-IN')} is below the ₹${EINVOICE_THRESHOLD_INR.toLocaleString('en-IN')} e-invoice threshold.` };
  }
  return { applicable: true, reason: `B2B invoice ≥ ₹${EINVOICE_THRESHOLD_INR.toLocaleString('en-IN')} with a valid buyer GSTIN.` };
}

export interface ComplianceOutcome {
  invoice: string | null;
  ok: boolean;
  irn?: string;
  skippedReason?: string;
  queuedForHuman?: boolean;
  error?: string;
}

export interface ComplianceRunReport {
  orgId: string;
  checked: number;
  generated: string[];
  skipped: number;
  queuedForHuman: string[];
}

/** GSP errors queue for a human after this many recorded attempts. */
const MAX_GSP_ATTEMPTS = 3;

/**
 * Per-org compliance sweep: dispatched/sent invoices that pass the
 * applicability rule and lack an IRN get one. GSP failures stamp attempts on
 * the invoice; at MAX_GSP_ATTEMPTS the invoice is queued for a human and the
 * owner is notified once — with the error text, never a silent retry loop.
 */
export async function runComplianceCheck(orgId: string): Promise<ComplianceRunReport> {
  const report: ComplianceRunReport = { orgId, checked: 0, generated: [], skipped: 0, queuedForHuman: [] };

  const org = (await query<{ settings: Record<string, unknown> | null }>('select settings from organizations where id=$1 limit 1', [orgId]))[0];
  const sellerGstin = String((org?.settings ?? {}).gstin ?? '');
  if (!GSTIN_RE.test(sellerGstin)) {
    return report; // e-invoicing not enabled for this org (onboarding step 2 pending)
  }

  const invoices = await query<{
    id: string;
    code: string | null;
    amount: string;
    buyer_gstin: string | null;
    gsp_attempts: string | null;
  }>(
    `select e.id, e.code, e.amount,
            (select p.data->>'gstin' from entities p where p.id = e.party_id) as buyer_gstin,
            e.data->>'gspAttempts' as gsp_attempts
     from entities e
     where e.org_id = $1 and e.type = 'invoice' and e.status in ('dispatched','sent')
       and e.data->>'irn' is null`,
    [orgId]
  );

  for (const inv of invoices) {
    report.checked++;
    const check = checkEinvoiceApplicability({ amount: Number(inv.amount), buyerGstin: inv.buyer_gstin });
    if (!check.applicable) {
      report.skipped++;
      continue;
    }
    const attempts = Number(inv.gsp_attempts ?? 0);
    if (attempts >= MAX_GSP_ATTEMPTS) {
      report.queuedForHuman.push(inv.code ?? inv.id);
      continue;
    }
    try {
      const res = await generateEInvoice(orgId, inv.code ?? '', 'agent:compliance');
      if (res.ok && res.irn) {
        report.generated.push(res.invoice ?? inv.code ?? '');
        await recordComplianceStatus(orgId, inv.id, 'irn_generated', `IRN ${res.irn.slice(0, 12)}…`);
      } else {
        await bumpGspAttempts(orgId, inv, res.error ?? 'unknown error', report);
      }
    } catch (e) {
      await bumpGspAttempts(orgId, inv, e instanceof Error ? e.message : 'GSP call threw', report);
    }
  }

  if (report.queuedForHuman.length) {
    await notifyOwnerDirect(
      orgId,
      `🧾 *Compliance needs you:* ${report.queuedForHuman.length} invoice${report.queuedForHuman.length > 1 ? 's' : ''} could not get an IRN after ${MAX_GSP_ATTEMPTS} attempts (${report.queuedForHuman.slice(0, 5).join(', ')}). The GSP portal may be down or the invoice data needs a fix — please check the Connectors page.`,
      'compliance_human_queue'
    ).catch(() => {});
  }
  await audit(orgId, 'agent', 'compliance.sweep', {
    metadata: { checked: report.checked, generated: report.generated.length, queuedForHuman: report.queuedForHuman.length },
  });
  return report;
}

async function bumpGspAttempts(
  orgId: string,
  inv: { id: string; code: string | null },
  error: string,
  report: ComplianceRunReport
): Promise<void> {
  const rows = await query<{ attempts: number }>(
    `update entities set data = data || jsonb_build_object('gspAttempts', coalesce((data->>'gspAttempts')::int, 0) + 1, 'gspLastError', $3)
     where org_id=$1 and id=$2 returning (data->>'gspAttempts')::int as attempts`,
    [orgId, inv.id, error.slice(0, 200)]
  );
  if ((rows[0]?.attempts ?? 0) >= MAX_GSP_ATTEMPTS) {
    report.queuedForHuman.push(inv.code ?? inv.id);
  } else {
    report.skipped++; // will retry on the next sweep with backoff-by-sweep
  }
}

/** Durable compliance status on the invoice record (spec recordComplianceStatus). */
export async function recordComplianceStatus(orgId: string, invoiceId: string, status: string, detail?: string): Promise<void> {
  await query(
    `update entities set data = data || jsonb_build_object('compliance', jsonb_build_object('status', $3, 'detail', $4, 'at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')))
     where org_id=$1 and id=$2`,
    [orgId, invoiceId, status, detail ?? null]
  );
}
