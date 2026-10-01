import { ingestReading, type TelemetryReading } from '@factory/agents';
import { audit } from '@factory/db';
import { limit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * POST /api/ingest/machine — Agent 13 P2b sensor path (spec): the edge
 * gateway posts telemetry readings here. Single reading or a batch:
 *   { orgId, readings: [{ machineCode, metric, value, unit? }] }
 *   { orgId, machineCode, metric, value, unit? }   (single, shorthand)
 * Auth: an operator-side ingest token (MACHINE_INGEST_TOKEN) when set —
 * the gateway is a separate device, so it authenticates with a shared
 * secret rather than a user session. Anomalies are stored, alerted on the
 * activity timeline and queued to the owner's WhatsApp; healthy readings
 * nudge the machine's baseline (EWMA) so the model tracks reality.
 */
function guard(req: Request, orgId: string): Response | null {
  const secret = process.env.MACHINE_INGEST_TOKEN;
  if (!secret) return null;
  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${secret}`) return null;
  // token may also be org-scoped: "<secret>:<orgId>" so one gateway can't
  // write to another org's telemetry
  if (auth === `Bearer ${secret}:${orgId}`) return null;
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

export async function POST(req: Request) {
  // burst guard per gateway (600/min ≈ 10 sensors at 1 Hz); the token guard
  // below is the real auth, this just stops runaway devices drowning the DB
  const burst = limit('ingest:machine', 600, 60);
  if (!burst.ok) return Response.json({ error: 'ingest rate limited' }, { status: 429 });

  const body = (await req.json().catch(() => null)) as
    | { orgId?: string; readings?: TelemetryReading[]; machineCode?: string; metric?: string; value?: number; unit?: string }
    | null;
  if (!body?.orgId) return Response.json({ error: 'orgId required' }, { status: 400 });

  const denied = guard(req, body.orgId);
  if (denied) return denied;

  const readings: TelemetryReading[] = body.readings ?? [
    { machineCode: body.machineCode!, metric: body.metric as TelemetryReading['metric'], value: body.value!, unit: body.unit },
  ];
  if (!readings.length || readings.some((r) => !r.machineCode || !r.metric || !(r.value > 0))) {
    return Response.json({ error: 'each reading needs machineCode, metric and a positive value' }, { status: 400 });
  }

  const results = [];
  for (const r of readings) {
    results.push({ machineCode: r.machineCode, metric: r.metric, ...(await ingestReading(body.orgId, r)) });
  }
  const anomalies = results.filter((r) => r.anomaly);
  await audit(body.orgId, 'gateway', 'telemetry.ingested', {
    metadata: { readings: results.length, anomalies: anomalies.length },
  });

  return Response.json({
    ok: true,
    ingested: results.length,
    anomalies: anomalies.map((a) => a.anomaly),
    baselineMissing: results.filter((r) => r.baselineMissing).map((r) => `${r.machineCode}:${r.metric}`),
  });
}
