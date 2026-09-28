import { extractDocument, acceptDocument } from '@factory/agents';
import { query } from '@factory/db';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** GET /api/documents — intake list with extraction + review status. */
export async function GET() {
  const s = await getSession();
  const rows = await query(
    `select id, kind, filename, source, status, extraction, confidence, entity_id, created_at
     from documents where org_id = $1 order by created_at desc limit 100`,
    [s.orgId]
  );
  return Response.json({ documents: rows });
}

/**
 * POST /api/documents — upload doc text (PRD F4):
 * extraction to strict schema with confidence + review queue.
 * multipart handled at /api/documents/upload for real files.
 */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as { text: string; filename?: string; source?: 'upload' | 'email' | 'whatsapp' };
  if (!body?.text?.trim()) return Response.json({ error: 'text required' }, { status: 400 });
  try {
    const result = await extractDocument(s.orgId, { text: body.text, filename: body.filename, source: body.source ?? 'upload' });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'extraction failed' }, { status: 500 });
  }
}

/** PATCH — accept a reviewed document → creates sales order via policy. */
export async function PATCH(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as { id: string };
  if (!body?.id) return Response.json({ error: 'id required' }, { status: 400 });
  const res = await acceptDocument(s.orgId, body.id);
  return Response.json(res);
}
