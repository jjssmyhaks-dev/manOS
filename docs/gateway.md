# Machine telemetry gateway — operator guide

How to wire a real edge gateway (ESP32, Raspberry Pi, PLC data logger, or any
device that can POST JSON over HTTP) to Factory AI OS so machine sensor
readings become anomaly alerts on the owner's WhatsApp and the dashboard's
**Machine health** card.

## 1. What you need

| Thing | Where it comes from |
| --- | --- |
| Server URL | Your deployment, e.g. `https://your-app.vercel.app` |
| Ingest token | You generate it: `openssl rand -hex 32` — set as `MACHINE_INGEST_TOKEN` in the server's environment |
| Org ID | Shown on the server (e.g. from `GET /api/org` → `orgs[].id`), or use the org-scoped token variant below |
| Machine codes | Must match the machine master exactly (`CNC-1`, `Press-1`, …). Seeded factories ship with 5 machines |

**Org-scoped tokens (recommended when one gateway serves one factory):** the
endpoint also accepts `Authorization: Bearer <token>:<orgId>` — the gateway
then cannot write to another org's telemetry even if the base token leaks.

> If `MACHINE_INGEST_TOKEN` is unset the endpoint is open — fine for local
> dev, never in production.

## 2. Machine master baselines

On the **first reading** for a machine+metric, the server adopts the nominal
value declared on the machine master (`data.baselines`) and alerts whenever a
reading deviates more than the threshold (default 25%) from it. Healthy
readings then nudge the baseline (EWMA α=0.1) so it tracks real machine
behaviour; anomalous readings never move it.

Seed machines ship with `vibration: 2.2 mm/s`, `temperature: 68 °C`,
`current: 12 A`. To set your own:

```json
{ "data": { "baselines": { "vibration": 2.5, "temperature": 70, "pressure": 6 } } }
```

Machine without declared baselines? The first reading returns
`baselineMissing` — ingest still succeeds and is stored, but no anomaly
detection happens until a baseline is declared (or set explicitly via
`upsertBaseline`).

**Supported metrics:** `vibration` (mm/s), `temperature` (°C), `run_hours`
(h), `current` (A), `pressure` (bar). Units are auto-filled; override per
reading with `unit`.

## 3. Posting readings

### Single reading

```bash
curl -X POST https://your-app.vercel.app/api/ingest/machine \
  -H "Authorization: Bearer $MACHINE_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orgId":"<org-uuid>","machineCode":"CNC-1","metric":"vibration","value":2.3}'
```

### Batch (recommended — one POST per poll cycle)

```bash
curl -X POST https://your-app.vercel.app/api/ingest/machine \
  -H "Authorization: Bearer $MACHINE_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "<org-uuid>",
    "readings": [
      { "machineCode": "CNC-1",  "metric": "vibration",   "value": 2.3 },
      { "machineCode": "CNC-1",  "metric": "temperature", "value": 71 },
      { "machineCode": "Press-1","metric": "current",     "value": 14.5 }
    ]
  }'
```

Batch is all-or-nothing on validation (one bad row → HTTP 400 with the
reason; nothing is stored). Valid batches store every row and report
anomalies individually.

### Response

```json
{
  "ok": true,
  "ingested": 2,
  "anomalies": [
    { "anomalous": true, "deviationPct": 103.6, "baseline": 2.21, "thresholdPct": 25,
      "detail": "Above baseline 2.21 by 103.6% (threshold 25%)",
      "metric": "vibration", "value": 4.5, "machineCode": "CNC-2" }
  ],
  "baselineMissing": ["Press-1:pressure"]
}
```

Every anomaly: activity-timeline entry (`telemetry_anomaly`), a `🚨` WhatsApp
alert queued to the owner, and a card row on the dashboard within seconds.

## 4. Error handling (what the gateway should do)

| Status | Meaning | Gateway behaviour |
| --- | --- | --- |
| 200 | Stored (check `anomalies` / `baselineMissing` if you care) | Continue |
| 400 | Malformed body (missing `orgId`, non-positive value, bad batch row) | Fix the payload — do not retry as-is |
| 401 | Missing/wrong token | Re-provision the token; back off and alert locally |
| 429 | Rate limited (600 readings/min burst guard) | Exponential backoff, resume within the window |
| 5xx / network | Server unreachable | Buffer locally (keep the last ~1000 readings), retry with backoff — readings carry no timestamp, so re-send order = sequence order |

Minimal resilient loop (pseudocode):

```
every 30s:
  readings = pollSensors()
  try POST batch(readings)
  on 200: clear buffer
  on 429/5xx/network: buffer += readings; sleep(backoff *= 2, max 10min)
  on 400: log payload; drop row; sleep(30s)
```

## 5. Verifying the wiring

```bash
# 1. healthy reading (adopts/keeps baseline, no alert)
curl ... -d '{"orgId":"…","machineCode":"CNC-1","metric":"vibration","value":2.3}'
# 2. anomalous reading (~2× baseline → alert + timeline + WhatsApp)
curl ... -d '{"orgId":"…","machineCode":"CNC-1","metric":"vibration","value":4.5}'
# 3. dashboard → Machine health card shows CNC-1 red with the anomaly feed
# 4. GET /api/telemetry/machines returns the same picture as JSON
```

Maintenance team sees anomalies **higher-urgency than routine PM** (spec
Agent 13 P2b): the alert names machine, metric, value vs baseline and the
deviation %, before the next shift check.
