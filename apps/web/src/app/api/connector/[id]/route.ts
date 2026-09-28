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
    // Pending pushes = APPROVED tally_push approvals (never unapproved ones —
    // the policy engine is the gate) with their full payload for voucher import.
    const pending = await query<{ id: string; action_type: string; payload: Record<string, unknown> }>(
      `select id, action_type, payload from approvals
       where org_id=$1 and action_type='tally_push' and status='executed' and result->>'pushed' is null
       order by created_at asc limit 20`,
      [auth.orgId]
    );
    const rows = await query<{ id: string; body: string }>(
      `select id, body from notifications where org_id=$1 and channel='connector' and template='tally_push' and status='queued' limit 20`,
      [auth.orgId]
    );
    return Response.json({
      ok: true,
      pendingPushes: [
        ...pending.map((p) => ({ id: p.id, body: JSON.stringify(p.payload ?? {}), source: 'approval' })),
        ...rows.map((r) => ({ id: r.id, body: r.body, source: 'notification' })),
      ],
    });
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
    let okCount = 0;
    let failCount = 0;
    for (const a of body.acks ?? []) {
      await audit(auth.orgId, 'connector', 'tally.push_ack', {
        metadata: { sourceId: a.sourceId, ok: a.ok, error: a.error },
      });
      if (a.ok) {
        okCount++;
        // approval-sourced pushes: stamp result so they are not re-served
        await query(
          `update approvals set result = jsonb_build_object('pushed', true, 'pushed_at', now())
           where id = $1 and action_type = 'tally_push'`,
          [a.sourceId]
        );
        // notification-sourced pushes: mark done
        await query(
          `update notifications set status = 'sent' where id::text = $1 and channel = 'connector'`,
          [a.sourceId]
        );
      } else {
        failCount++;
        await query(
          `update approvals set result = jsonb_build_object('push_error', $2)
           where id = $1 and action_type = 'tally_push' and result->>'pushed' is null`,
          [a.sourceId, (a.error ?? 'push failed').slice(0, 300)]
        );
      }
    }
    await query(`update connectors set last_sync_at=now(), status='connected' where id=$1`, [id]);
    return Response.json({ ok: true, acked: okCount, failed: failCount });
  }

  return Response.json({ error: 'unknown op' }, { status: 400 });
}
