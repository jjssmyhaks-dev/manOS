# @factory/connector-desktop

Windows connector beside Tally Prime (PRD C-4). Runs on the customer PC, talks
to Tally's local XML-over-HTTP interface (`http://localhost:9000`) and connects
**outbound only** to the Factory AI OS API with a device token.

## Configure

```bash
set FACTORY_API=http://localhost:3100
set FACTORY_CONNECTOR_ID=<connector uuid>
set FACTORY_DEVICE_TOKEN=<token from connectors table>
set TALLY_HOST=localhost
set TALLY_PORT=9000
set TALLY_COMPANY=Precision Metalworks Pvt Ltd
npm start -w @factory/connector-desktop
```

## What it does

1. **Heartbeat** every 30s with liveness + "last synced" status for the UI;
   receives any queued, approved Tally pushes.
2. **Pull**: masters (ledgers, stock items) and vouchers since last cursor,
   normalised and posted to `/api/connector/:id?op=pull`.
3. **Push**: executes approved voucher imports (XML) against Tally, reports
   per-record results to `/api/connector/:id?op=ack`.
4. Offline queue with retry/backoff; clear error when Tally is closed or XML
   access is disabled (C-4 reliability rules).

Electron packaging (tray app + auto-start) is a distribution step — the sync
engine here is the core.
