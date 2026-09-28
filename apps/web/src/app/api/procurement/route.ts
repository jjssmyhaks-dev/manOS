import { runMetric } from '@factory/agents';
import { draftRfqTool } from '@factory/agents';
import { query } from '@factory/db';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** GET /api/procurement — RFQ list + vendor quotes. */
export async function GET() {
  const s = await getSession();
  const rfqs = await query(
    `select id, code, status, party_id, qty, data from entities
     where org_id=$1 and type='rfq' order by created_at desc limit 50`,
    [s.orgId]
  );
  return Response.json({ rfqs });
}

/** POST /api/procurement — trigger agent RFQ drafting for low stock. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as { action: string };

  if (body.action === 'draft_rfqs') {
    // run the same tool the agent uses, bound to this session's org
    const tool = draftRfqTool({ orgId: s.orgId, role: s.role });
    const result = await tool.execute?.({}, { messages: [], toolCallId: 'api' });
    return Response.json({ ok: true, ...(result as object) });
  }
  return Response.json({ error: 'unknown action' }, { status: 400 });
}
