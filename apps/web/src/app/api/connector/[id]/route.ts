import { query, audit, upsertEntityBySource } from '@factory/db';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * /api/connector/:id — edge connector API (PRD C-4).
 * The desktop Tally connector authenticates with a device token and:
 *  POST /heartbeat        — liveness + pending push batch
 *  POST /pull             — results of master/voucher pulls (normalised rows)
 *  POST /ack              — per-record push results
 */

async function orgFromToken(req: Request, connectorId: string): Promise<{ orgId: string; connectorType: string } | null> {
  const token = req.headers.get('x-device-token');
  if (!token) return null;
  const rows = await query<{ org_id: string; type: string }>(
    'select org_id, type from connectors where id = $1 and device_token = $2 limit 1',
    [connectorId, token]
  );
  if (!rows[0]) return null;
  return { orgId: rows[0].org_id, connectorType: rows[0].type };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await orgFromToken(req, id);
  if (!auth) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const op = url.searchParams.get('op') ?? 'heartbeat';
  const body = (await req.json().catch(() => ({}))) as {
    status?: string;
    error?: string;
    records?: Array<Record<string, unknown>>;
    acks?: Array<{ sourceId: string; ok: boolean; error?: string }>;
  };

  if (op === 'heartbeat') {
    await query(`update connectors set status=$2, last_sync_at=now(), last_error=$3 where id=$1`, [id, body.status ?? 'connected', body.error ?? null]);
    const pending = await query<{ id: string; payload: string }>(
      `select id, body from notifications where org_id=$1 and channel='connector' and template='tally_push' and status='queued' limit 20`,
      [auth.orgId]
    );
    return Response.json({ ok: true, pendingPushes: pending });
  }

  if (op === 'pull') {
    let n = 0;
    for (const rec of body.records ?? []) {
      await upsertEntityBySource(
        auth.orgId,
        'tally',
        String(rec.sourceId ?? ''),
        {
          type: (rec.type as 'party' | 'item') ?? 'item',
          code: rec.code as string | undefined,
          name: rec.name as string | undefined,
          amount: rec.amount as number | undefined,
          qty: rec.qty as number | undefined,
          rate: rec.rate as number | undefined,
          date: rec.date as string | undefined,
          status: rec.status as string | undefined,
          data: (rec.data as Record<string, unknown>) ?? {},
        }
      );
      n++;
    }
    await query(`update connectors set last_sync_at=now(), status='connected' where id=$1`, [id]);
    await audit(auth.orgId, 'connector', 'tally.pull', { metadata: { records: n } });
    return Response.json({ ok: true, stored: n });
  }

  if (op === 'ack') {
    for (const a of body.acks ?? []) {
      await audit(auth.orgId, 'connector', 'tally.push_ack', {
        metadata: { sourceId: a.sourceId, ok: a.ok, error: a.error },
      });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'unknown op' }, { status: 400 });
}
