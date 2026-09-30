import { extractDocumentFromImage } from '@factory/agents';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/documents/image — multimodal intake: photo of a PO, invoice,
 * challan or handwritten job card → same strict schema as text intake.
 * Requires a vision model (OpenRouter key); otherwise 422 with guidance.
 */
export async function POST(req: Request) {
  const s = await getSession();
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return Response.json({ error: 'file required' }, { status: 400 });
  if (file.size > 8 * 1024 * 1024) return Response.json({ error: 'file too large (8MB max)' }, { status: 413 });
  if (!file.type.startsWith('image/')) return Response.json({ error: 'image file required (jpg/png/webp)' }, { status: 415 });

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const result = await extractDocumentFromImage(s.orgId, {
      filename: file.name,
      imageBase64: buf.toString('base64'),
      mimeType: file.type,
      source: 'upload',
    });
    return Response.json({ ok: true, filename: file.name, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'image extraction failed';
    const needsModel = /vision model/i.test(msg);
    return Response.json({ error: msg, needsVisionModel: needsModel }, { status: needsModel ? 422 : 500 });
  }
}
