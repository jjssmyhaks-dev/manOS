import { getSession } from '@/lib/session';
import { eInvoiceStatus, generateEInvoice } from '@factory/agents';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** GET /api/einvoice?invoice=INV-2001 — status for the invoice UI. */
export async function GET(req: Request) {
  const s = await getSession();
  const code = new URL(req.url).searchParams.get('invoice');
  if (!code) return Response.json({ error: 'invoice query param required' }, { status: 400 });
  const status = await eInvoiceStatus(s.orgId, code);
  return Response.json(status);
}

/** POST /api/einvoice {invoice} — generate the IRN via the GSP (idempotent). */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as { invoice?: string };
  if (!body.invoice) return Response.json({ error: 'invoice required' }, { status: 400 });
  const res = await generateEInvoice(s.orgId, body.invoice, `user:${s.userName}`);
  return Response.json(res, { status: res.ok ? 200 : 400 });
}
