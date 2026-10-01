import { query } from '@factory/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health — liveness + readiness probe for uptime monitors and the
 * operator smoke test. Auth-free by design (no sensitive data): it answers
 * whether the process is up and whether the database round-trips.
 * Vercel Cron config lives in vercel.json; point an external monitor
 * (BetterStack/UptimeRobot) at this URL for alerting.
 */
const startedAt = Date.now();

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string; ms?: number }> = {};

  // DB round-trip (works on both PGlite and remote Postgres)
  const t0 = Date.now();
  try {
    const rows = await query<{ n: string }>('select count(*)::text as n from organizations');
    checks.db = { ok: true, ms: Date.now() - t0, detail: `${rows[0]?.n ?? 0} orgs` };
  } catch (e) {
    checks.db = { ok: false, detail: e instanceof Error ? e.message : 'db unreachable' };
  }

  // integration wiring status (booleans only — never values)
  checks.integrations = {
    ok: true,
    detail: [
      `openrouter:${process.env.OPENROUTER_API_KEY ? 'configured' : 'fallback'}`,
      `whatsapp:${process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID ? 'live' : 'echo'}`,
      `sarvam_stt:${process.env.SARVAM_API_KEY ? 'on' : 'off'}`,
      `gsp:${process.env.GSP_PROVIDER ? 'configured' : 'sandbox'}`,
      `ingest_token:${process.env.MACHINE_INGEST_TOKEN ? 'on' : 'off'}`,
    ].join(' '),
  };

  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json(
    {
      ok,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      version: process.env.npm_package_version ?? '0.1.0',
      checks,
    },
    { status: ok ? 200 : 503 }
  );
}
