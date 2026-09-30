import { getSession } from '@/lib/session';
import { listActivity } from '@factory/agents';
import { audit } from '@factory/db';
import { buildPdf, type PdfLine } from '@/lib/pdf';

export const runtime = 'nodejs';

/**
 * GET /api/activity/export?format=csv|pdf&q=… — exportable audit trail
 * (design partners share it with their accountants). Same data as the AI
 * Activity timeline, oldest-first for ledger reading, with the same org
 * scoping as every other query. No deletions ever appear here: undone
 * actions stay in the log with their status — the trail is append-only.
 */

const esc = (v: string | null | undefined): string => `"${String(v ?? '').replace(/"/g, '""')}"`;

function fmt(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export async function GET(req: Request) {
  const s = await getSession();
  const url = new URL(req.url);
  const format = url.searchParams.get('format') === 'pdf' ? 'pdf' : 'csv';
  const search = url.searchParams.get('q') ?? undefined;

  const rows = (await listActivity(s.orgId, { search, limit: 1000 })).slice().reverse(); // oldest → newest
  const stamp = new Date().toISOString().slice(0, 10);
  await audit(s.orgId, `user:${s.userName}`, 'activity.exported', {
    metadata: { format, rows: rows.length, search: search ?? null },
  }).catch(() => {});

  if (format === 'csv') {
    const header = ['Date/Time (UTC)', 'Actor', 'Action', 'Summary', 'Reason', 'Status', 'Executed at', 'Undone at', 'Feedback', 'Sources'];
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      lines.push(
        [
          fmt(r.created_at),
          r.actor,
          r.action_type,
          r.summary,
          r.reason ?? '',
          r.status,
          fmt(r.executed_at),
          fmt(r.undone_at),
          r.feedback ?? '',
          (r.sources ?? []).map((x) => x.label).join('; '),
        ]
          .map(esc)
          .join(',')
      );
    }
    const body = '\ufeff' + lines.join('\r\n') + '\r\n'; // BOM so Excel opens UTF-8 cleanly
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="ai-activity-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  // PDF audit pack
  const pdfLines: PdfLine[] = [];
  pdfLines.push({ text: `${s.orgName} — generated ${fmt(new Date().toISOString())} · ${rows.length} entries (oldest first)`, size: 8, gapAfter: 10 });
  if (search) pdfLines.push({ text: `Filter: "${search}"`, size: 8, gapAfter: 8 });
  for (const r of rows) {
    pdfLines.push({ text: `${fmt(r.created_at)}  ·  ${r.status.toUpperCase()}  ·  ${r.action_type}`, bold: true, size: 8.5 });
    pdfLines.push({ text: r.summary, size: 9 });
    if (r.reason) pdfLines.push({ text: `Why: ${r.reason}`, size: 8 });
    const src = (r.sources ?? []).map((x) => x.label).join('; ');
    if (src) pdfLines.push({ text: `Sources: ${src}`, size: 8 });
    const flags = [
      r.undone_at ? `undone ${fmt(r.undone_at)}` : null,
      r.feedback ? `owner feedback: ${r.feedback === 'up' ? 'helpful' : 'not helpful'}` : null,
    ].filter(Boolean) as string[];
    if (flags.length) pdfLines.push({ text: flags.join('  ·  '), size: 8 });
    pdfLines.push({ text: '', size: 4 });
  }
  const pdf = buildPdf(`AI Activity Log — ${s.orgName}`, pdfLines);
  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="ai-activity-${stamp}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
