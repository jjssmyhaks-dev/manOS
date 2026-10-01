#!/usr/bin/env node
/**
 * Operator smoke test — run against a live Factory AI OS server.
 *
 * Usage:
 *   npm run smoke -w apps/web          # against http://localhost:3100
 *   BASE_URL=https://factory.example npm run smoke -w apps/web   # against a deploy
 *
 * Checks (spec pilot-readiness: "operator opens the OS and it works"):
 *   GET  /                 → 2xx–3xx (dashboard renders)
 *   GET  /api/health       → { ok: true } (DB round-trips, integrations wired)
 *   GET  /api/jobs/daily   → { ok: true } (agent sweep runs end-to-end)
 *   POST /api/jobs/daily   → { ok: true } (full daily agent run completes)
 *   POST /api/ingest/machine → gateway answers (optional; skips when absent)
 */
const BASE = (process.env.BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  return { status: res.status, ok: res.status >= 200 && res.status < 400 };
}

try {
  const { ok, status } = await get('/');
  check('GET /', ok, `HTTP ${status}`);
} catch (e) {
  check('GET /', false, String(e));
}

// Health probe: DB round-trip + integration wiring (what uptime monitors hit).
try {
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json().catch(() => ({}));
  check('GET /api/health', res.ok && body.ok === true, `HTTP ${res.status} db=${body.checks?.db?.ms ?? '?'}ms`);
} catch (e) {
  check('GET /api/health', false, String(e));
}

// Agent sweep: GET is the monitoring snapshot, POST runs the full daily loop.
for (const method of ['GET', 'POST']) {
  try {
    const res = await fetch(`${BASE}/api/jobs/daily`, { method });
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON body is itself a failure below */
    }
    check(`${method} /api/jobs/daily`, res.ok && body.ok === true, `HTTP ${res.status} ok=${body.ok}`);
  } catch (e) {
    check(`${method} /api/jobs/daily`, false, String(e));
  }
}

// Optional machine-gateway liveness probe (P2b): skip silently when absent.
try {
  const res = await fetch(`${BASE}/api/ingest/machine`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  // auth failure is fine here — it proves the gateway endpoint exists and answers
  check('POST /api/ingest/machine (gateway answers)', res.status === 401 || res.status === 400 || res.ok, `HTTP ${res.status}`);
} catch {
  console.log('SKIP  POST /api/ingest/machine — gateway not deployed');
}

console.log(`\n${failures ? `SMOKE FAILED: ${failures} check(s) failed` : 'Smoke passed — server is alive and the agent sweep runs.'}`);
process.exit(failures ? 1 : 0);
