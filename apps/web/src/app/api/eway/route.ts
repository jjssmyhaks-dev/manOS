import { getSession } from '@/lib/session';
import { generateEWayBill } from '@factory/agents';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/eway {invoice, vehicleNumber, fromPincode, toPincode} — generate + store the EWb. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as {
    invoice?: string;
    vehicleNumber?: string;
    fromPincode?: string;
    toPincode?: string;
    transporterName?: string;
  };
  if (!body.invoice || !body.vehicleNumber || !body.fromPincode) {
    return Response.json({ error: 'invoice, vehicleNumber and fromPincode are required' }, { status: 400 });
  }
  const res = await generateEWayBill(
    s.orgId,
    body.invoice,
    {
      vehicleNumber: body.vehicleNumber,
      fromPincode: body.fromPincode,
      toPincode: body.toPincode ?? '',
      transporterName: body.transporterName,
    },
    `user:${s.userName}`
  );
  return Response.json(res, { status: res.generated || res.ewbNo ? 200 : 400 });
}
