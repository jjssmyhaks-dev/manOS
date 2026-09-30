import { query, audit } from '@factory/db';
import {
  CsvConnector,
  parseZohoConfig,
  zohoTestConnection,
  ZohoBooksConnector,
  parseQboConfig,
  qboTestConnection,
  QuickBooksConnector,
  parseTallyServerConfig,
  tallyTestConnection,
  tallySync,
  whatsappTestConnection,
  whatsappEnvConfig,
} from '@factory/connectors';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** Mask a secret, keeping a hint of the original for recognition. */
function mask(v: string): string {
  return v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

/** GET /api/connectors — connector health list with config hints (never secrets). */
export async function GET() {
  const s = await getSession();
  const rows = await query<{ type: string; status: string; config: Record<string, unknown>; last_sync_at: string | null; last_error: string | null }>(
    `select type, status, config, last_sync_at, last_error from connectors where org_id = $1 order by type`,
    [s.orgId]
  );
  const wa = whatsappEnvConfig();
  const connectors = rows.map((r) => {
    const c = (r.config ?? {}) as Record<string, unknown>;
    let hint = '';
    if (r.type === 'zoho_books') {
      hint = c.clientId ? `client ${mask(String(c.clientId))} · org ${String(c.organizationId ?? '')}` : '';
    } else if (r.type === 'quickbooks') {
      hint = c.clientId ? `${String(c.environment ?? 'sandbox')} · realm ${String(c.realmId ?? '')}` : '';
    } else if (r.type === 'tally') {
      const mode = String(c.mode ?? 'desktop-agent');
      hint = mode === 'server' ? `${String(c.host)}:${String(c.port ?? 9000)} · ${String(c.company)}` : 'desktop agent (device token)';
    } else if (r.type === 'whatsapp') {
      hint = wa.echo ? 'using env credentials or echo mode' : 'using env credentials (live)';
    }
    return { type: r.type, status: r.status, last_sync_at: r.last_sync_at, last_error: r.last_error, hint };
  });
  return Response.json({ connectors });
}

/**
 * POST /api/connectors — real connector management:
 *   test        → live round-trip (Zoho org fetch / Tally company list / Graph API)
 *   configure   → store credentials server-side (org-scoped row), status=registered
 *   sync        → pull masters/contacts/items/invoices into entities now
 *   push_voucher→ direct Tally voucher push for an approved tally_push
 *   import_csv / register_tally → unchanged legacy actions
 */
export async function POST(req: Request) {
  const s = await getSession();
  const body = (await req.json().catch(() => ({}))) as {
    action: 'test' | 'configure' | 'sync' | 'push_voucher' | 'import_csv' | 'register_tally';
    type?: string;
    config?: Record<string, unknown>;
    voucherNo?: string;
    csvText?: string;
    csv?: string;
  };

  try {
    // ---------- test: live round-trip per connector type ----------
    if (body.action === 'test' && body.type) {
      if (body.type === 'whatsapp') {
        const wa = whatsappEnvConfig();
        if (wa.echo) {
          return Response.json({ ok: false, error: 'No WhatsApp credentials on this deployment (echo mode). The operator sets WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID.' });
        }
        const t = await whatsappTestConnection({ token: wa.token!, phoneNumberId: wa.phoneNumberId!, graphVersion: wa.graphVersion });
        return Response.json(t.ok ? { ok: true, detail: `Live: ${t.displayName}` } : t);
      }

      if (body.type === 'zoho_books') {
        const row = await query<{ config: Record<string, unknown> }>('select config from connectors where org_id=$1 and type=$2 limit 1', [s.orgId, 'zoho_books']);
        const cfg = parseZohoConfig(body.config ?? row[0]?.config);
        if (!cfg) return Response.json({ ok: false, error: 'Configure client id, secret, refresh token and organisation id first.' });
        const t = await zohoTestConnection(cfg);
        return Response.json(t.ok ? { ok: true, detail: `Live: ${t.orgName}` } : t);
      }

      if (body.type === 'quickbooks') {
        const row = await query<{ config: Record<string, unknown> }>('select config from connectors where org_id=$1 and type=$2 limit 1', [s.orgId, 'quickbooks']);
        const cfg = parseQboConfig(body.config ?? row[0]?.config);
        if (!cfg) return Response.json({ ok: false, error: 'Configure client id, secret, refresh token and company realm id first.' });
        const t = await qboTestConnection(cfg);
        return Response.json(t.ok ? { ok: true, detail: `Live: ${t.companyName}` } : t);
      }

      if (body.type === 'tally') {
        const row = await query<{ config: Record<string, unknown>; id: string }>('select config, id from connectors where org_id=$1 and type=$2 limit 1', [s.orgId, 'tally']);
        const cfg = parseTallyServerConfig({ ...(row[0]?.config ?? {}), ...(body.config ?? {}) });
        if (!cfg) return Response.json({ ok: false, error: 'Enter the Tally host, port and company name first (or register the desktop connector).' });
        const t = await tallyTestConnection(cfg);
        await query(`update connectors set status = $2, last_error = $3 where org_id = $1 and type = 'tally'`, [
          s.orgId, t.ok ? 'connected' : 'error', t.error ?? null,
        ]);
        return Response.json(t.ok ? { ok: true, detail: t.error ? `${t.error}` : `Live: ${t.companies?.length ?? 0} companies found` } : t);
      }

      if (body.type === 'csv') return Response.json({ ok: true, detail: 'CSV import is always available — paste a sheet below.' });
      if (body.type === 'gsp') return Response.json({ ok: true, detail: 'GSP runs on the sandbox provider (set GSTZEN_API_KEY for live e-invoicing).' });
      return Response.json({ ok: false, error: `No live test for '${body.type}'` });
    }

    // ---------- configure: store credentials for a connector ----------
    if (body.action === 'configure' && body.type && body.config) {
      if (body.type === 'tally') {
        await query(
          `insert into connectors (org_id, type, status, config) values ($1,'tally','registered',$2::jsonb)
           on conflict (org_id, type) do update set config = $2::jsonb, status = 'registered'`,
          [s.orgId, JSON.stringify({ mode: 'server', ...body.config })]
        );
      } else if (body.type === 'zoho_books') {
        await query(
          `insert into connectors (org_id, type, status, config) values ($1,'zoho_books','registered',$2::jsonb)
           on conflict (org_id, type) do update set config = $2::jsonb, status = 'registered'`,
          [s.orgId, JSON.stringify(body.config)]
        );
      } else if (body.type === 'quickbooks') {
        await query(
          `insert into connectors (org_id, type, status, config) values ($1,'quickbooks','registered',$2::jsonb)
           on conflict (org_id, type) do update set config = $2::jsonb, status = 'registered'`,
          [s.orgId, JSON.stringify(body.config)]
        );
      } else {
        return Response.json({ error: `'${body.type}' is configured via environment or its own app` }, { status: 400 });
      }
      await audit(s.orgId, `user:${s.userName}`, 'connector.configured', { metadata: { type: body.type } });
      return Response.json({ ok: true });
    }

    // ---------- sync: pull now ----------
    if (body.action === 'sync' && body.type) {
      if (body.type === 'zoho_books') {
        const row = await query<{ id: string; config: Record<string, unknown> }>('select id, config from connectors where org_id=$1 and type=$2 limit 1', [s.orgId, 'zoho_books']);
        const cfg = parseZohoConfig(row[0]?.config);
        if (!cfg || !row[0]) return Response.json({ error: 'Configure the Zoho Books connection first.' }, { status: 400 });
        const conn = new ZohoBooksConnector();
        const results = [];
        for (const entity of ['parties', 'items', 'invoices'] as const) {
          results.push(await conn.sync(s.orgId, row[0].id, entity));
        }
        const pulled = results.reduce((sum, r) => sum + r.pulled, 0);
        const errors = results.flatMap((r) => r.errors);
        return Response.json({ ok: errors.length === 0, pulled, detail: `Pulled ${pulled} records from Zoho Books`, errors });
      }
      if (body.type === 'quickbooks') {
        const row = await query<{ id: string; config: Record<string, unknown> }>('select id, config from connectors where org_id=$1 and type=$2 limit 1', [s.orgId, 'quickbooks']);
        const cfg = parseQboConfig(row[0]?.config);
        if (!cfg || !row[0]) return Response.json({ error: 'Configure the QuickBooks connection first.' }, { status: 400 });
        const conn = new QuickBooksConnector();
        const results = [];
        for (const entity of ['parties', 'items', 'invoices'] as const) {
          results.push(await conn.sync(s.orgId, row[0].id, entity));
        }
        const pulled = results.reduce((sum, r) => sum + r.pulled, 0);
        const errors = results.flatMap((r) => r.errors);
        return Response.json({ ok: errors.length === 0, pulled, detail: `Pulled ${pulled} records from QuickBooks`, errors });
      }
      if (body.type === 'tally') {
        const row = await query<{ id: string; config: Record<string, unknown> }>('select id, config from connectors where org_id=$1 and type=$2 limit 1', [s.orgId, 'tally']);
        const cfg = parseTallyServerConfig(row[0]?.config);
        if (!cfg || !row[0]) return Response.json({ error: 'Configure the Tally host/company first (or use the desktop connector).' }, { status: 400 });
        const r = await tallySync(s.orgId, row[0].id, cfg);
        return Response.json({
          ok: r.errors.length === 0 || r.parties + r.items + r.vouchers > 0,
          pulled: r.parties + r.items + r.vouchers,
          detail: `Tally sync: ${r.parties} ledgers, ${r.items} stock items, ${r.vouchers} vouchers`,
          errors: r.errors,
        });
      }
      return Response.json({ error: `No server-side sync for '${body.type}'` }, { status: 400 });
    }

    // ---------- push_voucher: approved Tally push, direct ----------
    if (body.action === 'push_voucher' && body.voucherNo) {
      const row = await query<{ id: string; config: Record<string, unknown> }>('select id, config from connectors where org_id=$1 and type=$2 limit 1', [s.orgId, 'tally']);
      const cfg = parseTallyServerConfig(row[0]?.config);
      if (!cfg) return Response.json({ error: 'Direct push needs the server-mode Tally connection (host/port/company).' }, { status: 400 });
      const inv = await query<{ code: string | null; date: string; party_id: string | null; amount: string; customer: string | null; item: string | null }>(
        `select e.code, e.date::text, e.party_id, e.amount,
                coalesce((select coalesce(p.name, p.data->>'name') from entities p where p.id = e.party_id), '(unknown)') as customer,
                coalesce((select coalesce(i.name, i.data->>'name') from entities i where i.id = e.item_id), 'Goods') as item
         from entities e where e.org_id = $1 and e.type = 'invoice' and e.code = $2 limit 1`,
        [s.orgId, body.voucherNo]
      );
      const v = inv[0];
      if (!v) return Response.json({ error: `Invoice ${body.voucherNo} not found` }, { status: 404 });
      const { tallyPushVoucher } = await import('@factory/connectors');
      const res = await tallyPushVoucher(s.orgId, cfg, {
        voucherNo: v.code ?? body.voucherNo,
        date: v.date,
        partyLedger: v.customer ?? '(unknown)',
        lines: [{ item: v.item ?? 'Goods', qty: 1, rate: Number(v.amount), amount: Number(v.amount) }],
        totalAmount: Number(v.amount),
      });
      await audit(s.orgId, `user:${s.userName}`, 'connector.push_voucher', { metadata: { voucherNo: body.voucherNo, ok: res.ok } });
      return Response.json(res.ok ? { ok: true, detail: `Pushed to Tally: ${v.code}` } : { ok: false, error: res.error });
    }

    // ---------- legacy actions ----------
    if (body.action === 'import_csv') {
      if (!body.csvText?.trim() && !body.csv?.trim()) return Response.json({ error: 'csv text required' }, { status: 400 });
      const conn = new CsvConnector();
      const res = await conn.importCsv(s.orgId, (body.csvText ?? body.csv)!);
      await query(`update connectors set last_sync_at = now(), status='connected' where org_id=$1 and type='csv'`, [s.orgId]);
      return Response.json({ ok: true, ...res });
    }
    if (body.action === 'register_tally') {
      const token = `fct_${crypto.randomUUID().replaceAll('-', '')}`;
      const rows = await query<{ id: string }>(
        `insert into connectors (org_id, type, status, config, device_token)
         values ($1,'tally','registered',jsonb_build_object('mode','desktop-agent'),$2)
         on conflict (org_id, type) do update set device_token = excluded.device_token, status = 'registered'
         returning id`,
        [s.orgId, token]
      );
      await audit(s.orgId, `user:${s.userName}`, 'connector.registered', { metadata: { type: 'tally' } });
      return Response.json({ ok: true, connectorId: rows[0]!.id, deviceToken: token });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'connector action failed' }, { status: 500 });
  }
}
