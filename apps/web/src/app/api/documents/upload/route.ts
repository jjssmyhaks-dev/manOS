import { extractDocument } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/documents/upload — real file upload → extraction pipeline. */
export async function POST(req: Request) {
  const s = await getSession();
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'file required' }, { status: 400 });
  if (file.size > 8 * 1024 * 1024) return Response.json({ error: 'file too large (8MB max)' }, { status: 413 });

  const buf = Buffer.from(await file.arrayBuffer());
  // text-first extraction: PDFs via text layer in prod; txt/csv/markdown direct
  const isTexty = /\.(txt|csv|md|json)$/i.test(file.name) || file.type.startsWith('text/');
  const text = isTexty
    ? buf.toString('utf8')
    : buf.toString('utf8').replace(/[^\x20-\x7E\n\r\t₹]+/g, ' ').replace(/\s+/g, ' ').trim();

  const result = await extractDocument(s.orgId, {
    text: text.slice(0, 20000),
    filename: file.name,
    source: 'upload',
  });
  return Response.json({ ok: true, filename: file.name, ...result });
}
