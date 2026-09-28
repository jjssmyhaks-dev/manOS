# @factory/connectors

One interface (`auth/sync/read/write/webhookHandler/health`) implemented by every integration:

- `csv/import.ts` — Excel/CSV import with Tally-export column synonyms; upsert by sourceId
- `whatsapp.ts` — WhatsApp Cloud API signature verification + webhook parse + outbound payload
- `gsp.ts` — e-invoice/e-way bill provider interface (GSTZen / MasterGST / WhiteBooks; sandbox included)
- `tally/xml.ts` — Tally Prime XML-over-HTTP request builders + parsers (used by the desktop connector)
