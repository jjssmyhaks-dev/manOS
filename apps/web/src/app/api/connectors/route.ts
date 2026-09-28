import { query, audit } from '@factory/db';
import { CsvConnector } from '@factory/connectors';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** GET /api/connectors — connector health list (PRD F1). */
export async function GET() {
  const s = await getSession();
  const rows = await query(
    `select type, status, config, last_sync_at, last_error from connectors where org_id = $1 order by type`,
    [s.orgId]
  );
  return Response.json({ connectors: rows });
}

/** POST /api/connectors — actions: import_csv, set_status. */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json()) as { action: 'import_csv' | 'set_status'; type?: string; csv?: string; status?: string };
  try {
    if (body.action === 'import_csv') {
      if (!body.csv?.trim()) return Response.json({ error: 'csv text required' }, { status: 400 });
      const conn = new CsvConnector();
      const res = await conn.importCsv(s.orgId, body.csv);
      await query(`update connectors set last_sync_at = now(), status='connected' where org_id=$1 and type='csv'`, [s.orgId]);
      return Response.json({ ok: true, ...res });
    }
    if (body.action === 'set_status' && body.type) {
      await query(`update connectors set status=$3 where org_id=$1 and type=$2`, [s.orgId, body.type, body.status ?? 'connected']);
      await audit(s.orgId, `user:${s.userName}`, 'connector.status_changed', { metadata: { type: body.type, status: body.status } });
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'connector action failed' }, { status: 500 });
  }
}
