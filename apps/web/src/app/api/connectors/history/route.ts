import { getSession } from '@/lib/session';
import { getSyncHistory } from '@factory/core';

export const runtime = 'nodejs';

/** GET /api/connectors/history?type=tally — last 30 days of sync runs. */
export async function GET(req: Request) {
  const s = await getSession();
  const type = new URL(req.url).searchParams.get('type');
  if (!type) return Response.json({ error: 'type query param required' }, { status: 400 });
  const days = await getSyncHistory(s.orgId, type, 30);
  return Response.json({ days });
}
