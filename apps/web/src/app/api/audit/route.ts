import { query } from '@factory/db';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

/** GET /api/audit — audit trail (PRD F8). */
export async function GET(req: Request) {
  const s = await getSession();
  const url = new URL(req.url);
  const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
  const rows = await query(
    `select id, actor, action, entity_type, entity_id, metadata, created_at
     from audit_log where org_id = $1 order by created_at desc limit $2`,
    [s.orgId, limit]
  );
  return Response.json({ entries: rows });
}
