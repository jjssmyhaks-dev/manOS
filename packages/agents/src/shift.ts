import { query } from '@factory/db';
import { checkPolicyAndQueue } from '@factory/core';
import { executeAction } from './tools/write.js';

/**
 * Agent 8 — Production/Shift (spec): a WhatsApp voice note from an operator
 * becomes a structured shift report tied to their job card. Transcription
 * happens in the webhook (Sarvam saarika, already wired); this agent does the
 * DETERMINISTIC half: extract numbers from the transcript, sanity-check them
 * against the job card, and — only when a required field is missing or
 * wildly out of range — ask ONE short clarifying question instead of guessing
 * a number that lands in production records. The write flows through the
 * policy engine as 'job_card_update' (operational logging, low risk — orgs
 * may set it auto), so the approval machinery and activity timeline stay in
 * charge.
 */

export interface ShiftReport {
  jobCardCode: string | null;
  outputQty: number | null;
  rejectQty: number | null;
  downtimeMins: number | null;
  downtimeReason: string | null;
}

export interface ShiftIntakeResult {
  ok: boolean;
  /** final reply text for the operator (or the clarification question) */
  reply: string;
  needsClarification: boolean;
  clarification?: string;
  report?: ShiftReport;
  decision?: string;
  approvalId?: string;
  flags: string[];
  error?: string;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5, chah: 6, saat: 7, aath: 8, nau: 9, das: 10,
  bees: 20, tees: 30, chaudas: 40, paintees: 35, pachas: 50,
};

function numNear(text: string, label: string): number | null {
  // "output 250" / "output: 250" — label then number, no comma in between
  // (so "8 reject, downtime 45" can't read 45 as rejects)
  const after = text.match(new RegExp(`${label}\\s*[:\\-]?\\s*(\\d[\\d,]*)`, 'i'));
  if (after) return Number(after[1]!.replace(/,/g, ''));
  // "250 produced" / "8 reject" / "das rejects" — number then label
  const before = text.match(new RegExp(`(\\d[\\d,]*)\\s*(?:pcs?|pieces?|nos\\.?|units?)?\\s*${label}`, 'i'));
  if (before) return Number(before[1]!.replace(/,/g, ''));
  const w = text.match(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\s*${label}\\w*\\b`, 'i'));
  if (w) return NUMBER_WORDS[w[1]!.toLowerCase()] ?? null;
  return null;
}

/** Pull the shift report out of a transcript — no LLM required. */
export function extractShiftReport(transcript: string): ShiftReport {
  const t = transcript.toLowerCase();
  const jc =
    transcript.match(/\b(jc[-\s]?\d{2,4})\b/i)?.[1]?.replace(/\s+/g, '-').toUpperCase() ?? null;
  const output = numNear(t, 'output') ?? numNear(t, 'produc');
  const reject = numNear(t, 'reject') ?? numNear(t, 'kharab') ?? numNear(t, 'wastage');
  const downtime = numNear(t, 'downtime') ?? numNear(t, 'down ?time') ?? numNear(t, 'band');
  const reason =
    transcript.match(/(?:due to|because of|reason)\s+([a-z][a-z0-9 ,\-]{2,40})/i)?.[1]?.trim() ??
    (downtime != null ? (t.includes('tool') ? 'tool change' : t.includes('material') ? 'material shortage' : t.includes('power') ? 'power cut' : null) : null);

  return { jobCardCode: jc, outputQty: output ?? null, rejectQty: reject, downtimeMins: downtime, downtimeReason: reason };
}

/** Find the operator's open job card when the transcript doesn't name one. */
async function resolveJobCard(orgId: string, code: string | null): Promise<{ id: string; code: string | null; item_name: string | null; qty: string | null } | null> {
  if (code) {
    const byCode = await query<{ id: string; code: string | null; item_name: string | null; qty: string | null }>(
      `select jc.id, jc.code, coalesce((select coalesce(i.name, i.data->>'name') from entities i where i.id = jc.item_id), '(unknown)') as item_name, jc.qty
       from entities jc where jc.org_id=$1 and jc.type='job_card' and replace(upper(jc.code),'-','') = replace($2,'-','') limit 1`,
      [orgId, code]
    );
    if (byCode[0]) return byCode[0];
  }
  // fall back to the most recently active (running/queued) job card
  return (
    await query<{ id: string; code: string | null; item_name: string | null; qty: string | null }>(
      `select jc.id, jc.code, coalesce((select coalesce(i.name, i.data->>'name') from entities i where i.id = jc.item_id), '(unknown)') as item_name, jc.qty
       from entities jc where jc.org_id=$1 and jc.type='job_card' and jc.status in ('running','queued')
       order by jc.date desc limit 1`,
      [orgId]
    )
  )[0] ?? null;
}

/** Sanity: is the reported output plausible against the job card? */
export function sanityCheck(report: ShiftReport, jobCard: { qty: string | null } | null): string[] {
  const flags: string[] = [];
  if (report.outputQty == null) flags.push('missing output quantity');
  if (jobCard?.qty && report.outputQty != null && report.outputQty > Number(jobCard.qty) * 2) {
    flags.push(`output ${report.outputQty} is more than 2× the job card quantity (${Number(jobCard.qty)})`);
  }
  if (report.rejectQty != null && report.outputQty != null && report.rejectQty > report.outputQty) {
    flags.push('rejects exceed output — likely a mix-up');
  }
  if (report.downtimeMins != null && report.downtimeMins > 600) {
    flags.push('downtime over 10 hours in one shift — confirm');
  }
  return flags;
}

/** Intake entry: transcript → validated report → policy-gated job-card write. */
export async function processShiftNote(
  orgId: string,
  transcript: string,
  meta: { role?: string; via?: 'whatsapp-voice' | 'web' } = {}
): Promise<ShiftIntakeResult> {
  const report = extractShiftReport(transcript);
  const jobCard = await resolveJobCard(orgId, report.jobCardCode);
  const flags = sanityCheck(report, jobCard);

  // one short clarifying question — never a form (spec: askClarification)
  if (report.outputQty == null || !jobCard) {
    const missing = report.outputQty == null ? 'how many pieces were made' : 'which job card (e.g. JC-401)';
    return {
      ok: false,
      needsClarification: true,
      clarification: `Got it — ${missing}?`,
      reply: `Got it — ${missing}?`,
      report,
      flags,
    };
  }

  const payload = {
    jobCardId: jobCard.id,
    status: 'done',
    outputQty: report.outputQty,
    rejectQty: report.rejectQty ?? 0,
    downtimeMins: report.downtimeMins ?? 0,
    note: report.downtimeReason ? `Downtime: ${report.downtimeReason}` : undefined,
    via: meta.via ?? 'whatsapp-voice',
    __shiftReport: report,
  };

  const r = await checkPolicyAndQueue(
    {
      orgId,
      actionType: 'job_card_update',
      entityType: 'job_card',
      entityId: jobCard.id,
      payload,
      preview: `Shift report for ${jobCard.code}: output ${report.outputQty}${report.rejectQty ? `, rejects ${report.rejectQty}` : ''}${report.downtimeMins ? `, downtime ${report.downtimeMins}m` : ''} on ${jobCard.item_name ?? 'item'}`,
      risk: 'write',
    },
    (pl) => executeAction(orgId, 'job_card_update', pl as Record<string, unknown>)
  );

  const bits = [
    `✅ Shift logged for *${jobCard.code}* (${jobCard.item_name ?? 'item'}): output ${report.outputQty}`,
    report.rejectQty ? `· rejects ${report.rejectQty}` : '',
    report.downtimeMins ? `· downtime ${report.downtimeMins} min${report.downtimeReason ? ` (${report.downtimeReason})` : ''}` : '',
  ].filter(Boolean);
  if (flags.length) bits.push(`⚠️ ${flags[0]}`);
  if (r.decision === 'ask') bits.push('Waiting for approval before it updates the job card.');

  return { ok: r.decision !== 'deny', reply: bits.join('\n'), needsClarification: false, report, decision: r.decision, approvalId: r.approvalId, flags };
}
