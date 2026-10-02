import { initDb, insertEntity, query, exec } from './client.js';

/**
 * Synthetic seed generator (PRD §17): deterministic-ish demo data across the
 * four vertical packs so demos, evals and dev never touch real customer data.
 */

export interface SeedOrgSpec {
  slug: string;
  name: string;
  vertical: 'fabrication' | 'fmcg' | 'scrap' | 'exports';
}

export const SEED_ORGS: SeedOrgSpec[] = [
  { slug: 'precision-metalworks', name: 'Precision Metalworks Pvt Ltd', vertical: 'fabrication' },
  { slug: 'sunfresh-foods', name: 'Sunfresh Foods LLP', vertical: 'fmcg' },
  { slug: 'greencycle-recyclers', name: 'Greencycle Recyclers', vertical: 'scrap' },
  { slug: 'texstyle-exports', name: 'Texstyle Exports', vertical: 'exports' },
];

const FIRST = ['Rahul', 'Priya', 'Amit', 'Sneha', 'Vikram', 'Anita', 'Suresh', 'Meena', 'Arjun', 'Kavya'];
const LAST = ['Sharma', 'Patel', 'Reddy', 'Iyer', 'Singh', 'Gupta', 'Naik', 'Rao'];
const PRODUCTS: Record<string, string[]> = {
  fabrication: ['MS Bracket 200mm', 'SS Enclosure 4U', 'Conveyor Roller', 'Weldment Frame A', 'Laser-cut Plate 6mm'],
  fmcg: ['Masala Packet 100g', 'Pickle Jar 500g', 'Atta 5kg', 'Biscuit Carton', 'Juice Bottle 1L'],
  scrap: ['Copper Wire Scrap', 'Aluminium Sheet Lot', 'MS Turnings', 'Brass Radiator', 'Paper Bales'],
  exports: ['Cotton Shirt Lot', 'Leather Wallet Lot', 'Home Linen Set', 'Ceramic Mug Lot', 'Jute Bag Lot'],
};
const CITIES = ['Coimbatore', 'Rajkot', 'Ludhiana', 'Pune', 'Hyderabad', 'Jaipur', 'Faridabad', 'Chennai'];

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedDemoData(
  orgSlug = 'precision-metalworks',
  opts: { name?: string; vertical?: 'fabrication' | 'fmcg' | 'scrap' | 'exports' } = {}
): Promise<{ orgId: string; counts: Record<string, number> }> {
  const db = await initDb();
  const org = SEED_ORGS.find((o) => o.slug === orgSlug) ?? SEED_ORGS[0]!;
  const rnd = mulberry(42);

  // org row (opts.name lets signups get a workspace under their own company)
  const orgRows = await query<{ id: string }>(
    `insert into organizations (name, slug, vertical) values ($1,$2,$3)
     on conflict (slug) do update set name=excluded.name returning id`,
    [opts.name ?? org.name, orgSlug, opts.vertical ?? org.vertical],
    db
  );
  const orgId = orgRows[0]!.id;

  // Replace semantics (Settings: "Seeding replaces demo data"): drop the
  // previous seed-generated entities so repeated seeding never duplicates
  // rows. Non-seed data (Tally pulls, agent-created records, documents)
  // is left untouched.
  await query(`delete from entities where org_id=$1 and source='seed'`, [orgId], db);

  await query(
    `insert into users (org_id, email, name, role) values ($1,$2,$3,$4)
     on conflict (email) do nothing`,
    [orgId, `owner@${org.slug}.in`, `${pick(FIRST, rnd)} ${pick(LAST, rnd)}`, 'owner'],
    db
  );

  // default approval policies: outbound always ask, internal writes ask, reads auto
  const policyDefaults: Array<[string, string]> = [
    ['send_reminder', 'ask'],
    ['send_rfq', 'ask'],
    ['create_po', 'ask'],
    ['tally_push', 'ask'],
    ['digest_send', 'auto'],
    ['so_create', 'ask'],
  ];
  for (const [action, decision] of policyDefaults) {
    await query(
      `insert into policies (org_id, action_type, decision) values ($1,$2,$3) on conflict (org_id, action_type) do nothing`,
      [orgId, action, decision],
      db
    );
  }

  // connectors (disconnected until wired)
  for (const t of ['csv', 'tally', 'whatsapp', 'gmail']) {
    await query(
      `insert into connectors (org_id, type, status) values ($1,$2,$3) on conflict (org_id, type) do nothing`,
      [orgId, t, t === 'csv' ? 'connected' : 'disconnected'],
      db
    );
  }

  const products = PRODUCTS[org.vertical] ?? PRODUCTS.fabrication!;
  const counts: Record<string, number> = {};

  // parties
  for (let i = 0; i < 12; i++) {
    const isCustomer = i % 3 !== 2; // 8 customers, 4 vendors
    await insertEntity(
      {
        orgId,
        type: 'party',
        code: `${isCustomer ? 'CUS' : 'VEN'}-${String(i + 1).padStart(3, '0')}`,
        name: `${pick(LAST, rnd)} ${isCustomer ? pick(['Industries', 'Traders', 'Enterprises', 'Works'], rnd) : pick(['Suppliers', 'Metals', 'Polymers', 'Traders'], rnd)}`,
        status: 'active',
        source: 'seed',
        data: {
          kind: isCustomer ? 'customer' : 'vendor',
          gstin: `29ABCDE${1000 + i}F1Z${i % 10}`,
          city: pick(CITIES, rnd),
          state: 'Karnataka',
          paymentTermsDays: pick([15, 30, 45, 60], rnd),
          phone: `+9198${10000000 + Math.floor(rnd() * 89999999)}`,
          preferred: i % 4 === 0 && !isCustomer,
        },
      },
      db
    );
  }
  counts.parties = 12;

  // items
  const itemIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const reorderQty = Math.round(50 + rnd() * 300);
    const e = await insertEntity(
      {
        orgId,
        type: 'item',
        code: `ITM-${String(i + 1).padStart(3, '0')}`,
        name: products[i % products.length]!,
        status: 'active',
        source: 'seed',
        data: {
          uom: pick(['nos', 'kg', 'ltr'], rnd),
          hsn: `8${100000 + i * 111}`,
          gstRate: pick([0, 5, 12, 18], rnd),
          reorderPoint: reorderQty,
          reorderQty,
          stdRate: Math.round(120 + rnd() * 1800),
          category: org.vertical,
        },
      },
      db
    );
    itemIds.push(e.id);
  }
  counts.items = 10;

  // warehouses
  for (const w of ['Main Godown', 'FG Store', 'Raw Material Store']) {
    await insertEntity({ orgId, type: 'warehouse', name: w, status: 'active', source: 'seed', data: { city: 'Bengaluru' } }, db);
  }
  counts.warehouses = 3;

  // stock ledger + balances
  for (const itemId of itemIds) {
    let balance = Math.round(rnd() * 500);
    for (let d = 60; d >= 0; d -= 7) {
      const qty = Math.round((rnd() - 0.45) * 120);
      await insertEntity(
        {
          orgId, type: 'stock_ledger', itemId, date: daysAgo(d),
          qty, source: 'seed',
          data: { kind: qty >= 0 ? 'inward' : 'issue', balanceAfter: Math.max(0, balance) },
        },
        db
      );
      balance = Math.max(0, balance + qty);
    }
    // current balance as item data
    await exec(`update entities set data = jsonb_set(data, '{stockOnHand}', '${balance}'::jsonb) where org_id='${orgId}' and id='${itemId}'`, db);
  }

  // sales orders + invoices across last 90 days
  const partyRows = await query<{ id: string; name: string | null; data: Record<string, unknown> }>(
    `select id, name, data from entities where org_id='${orgId}' and type='party'`, [], db
  );
  const customers = partyRows.filter((p) => (p.data as { kind?: string } | undefined)?.kind === 'customer');
  const vendors = partyRows.filter((p) => (p.data as { kind?: string } | undefined)?.kind === 'vendor');

  for (let i = 0; i < 40; i++) {
    const cust = pick(customers, rnd) as { id: string; name: string | null; data: Record<string, unknown> };
    const item = pick(itemIds, rnd);
    const qty = Math.round(10 + rnd() * 200);
    const rate = Math.round(120 + rnd() * 1800);
    const day = daysAgo(Math.floor(rnd() * 90));
    const isOverdue = rnd() < 0.3;
    const so = await insertEntity(
      {
        orgId, type: 'sales_order', code: `SO-${1000 + i}`, partyId: cust.id, itemId: item, qty, rate,
        amount: qty * rate, date: day, status: pick(['confirmed', 'in_production', 'dispatched', 'closed'], rnd),
        source: 'seed',
        data: { poNumber: `PO-${500 + i}`, poDate: day, deliveryDate: daysAgo(Math.floor(rnd() * 80)), dueDate: day },
      },
      db
    );
    // invoice for ~70% of orders; some overdue
    if (rnd() < 0.7) {
      const invDate = daysAgo(Math.floor(5 + rnd() * 85));
      const dueDays = pick([15, 30, 45], rnd);
      const due = new Date(invDate);
      due.setDate(due.getDate() + dueDays);
      const overdueDays = Math.floor((Date.now() - due.getTime()) / 86400000);
      await insertEntity(
        {
          orgId, type: 'invoice', code: `INV-${2000 + i}`, partyId: cust.id, itemId: item,
          amount: Math.round(qty * rate * (1 + rnd() * 0.18)), date: invDate,
          status: overdueDays > 0 ? 'overdue' : pick(['sent', 'paid'], rnd),
          source: 'seed',
          data: {
            soId: so.id, dueDate: due.toISOString().slice(0, 10),
            gstin: (cust.data?.gstin as string) ?? null, paid: overdueDays <= 0 && rnd() > 0.4,
            overdueDays: Math.max(0, overdueDays),
          },
        },
        db
      );
    }
  }
  counts.sales_orders = 40;

  // purchase orders
  for (let i = 0; i < 15; i++) {
    const vend = pick(vendors, rnd) as { id: string; name: string | null; data: Record<string, unknown> };
    const item = pick(itemIds, rnd);
    const qty = Math.round(50 + rnd() * 500);
    const rate = Math.round(80 + rnd() * 900);
    await insertEntity(
      {
        orgId, type: 'purchase_order', code: `PO-S-${3000 + i}`, partyId: vend.id, itemId: item, qty, rate,
        amount: qty * rate, date: daysAgo(Math.floor(rnd() * 60)), status: pick(['draft', 'sent', 'received'], rnd),
        source: 'seed',
        data: { expectedDate: daysAgo(-Math.floor(rnd() * 20)), vendorGstin: (vend.data?.gstin as string) ?? null },
      },
      db
    );
  }
  counts.purchase_orders = 15;

  // job cards (fabrication/fmcg flavour)
  for (let i = 0; i < 14; i++) {
    const item = pick(itemIds, rnd);
    await insertEntity(
      {
        orgId, type: 'job_card', code: `JC-${400 + i}`, itemId: item,
        qty: Math.round(20 + rnd() * 300), date: daysAgo(Math.floor(rnd() * 30)),
        status: pick(['queued', 'running', 'done', 'blocked'], rnd),
        source: 'seed',
        data: {
          machine: pick(['CNC-1', 'CNC-2', 'Press-1', 'Assembly-1', 'Packing-1'], rnd),
          shift: pick(['A', 'B'], rnd),
          outputQty: Math.round(10 + rnd() * 250),
          rejectQty: Math.round(rnd() * 12),
          downtimeMins: Math.round(rnd() * 90),
        },
      },
      db
    );
  }
  counts.job_cards = 14;

  // machines — data.baselines is the machine-master nominal values the P2b
  // sensor path adopts on first sighting (telemetry.getBaseline)
  for (const m of ['CNC-1', 'CNC-2', 'Press-1', 'Assembly-1', 'Packing-1']) {
    await insertEntity(
      {
        orgId, type: 'machine', code: m, name: m, status: 'running',
        source: 'seed',
        data: {
          lastPmDate: daysAgo(45), pmIntervalDays: pick([30, 60, 90], rnd),
          baselines: { vibration: 2.2, temperature: 68, current: 12 },
        },
      },
      db
    );
  }
  counts.machines = 5;

  // P2b demo telemetry: a week of readings per machine+metric around the
  // declared baselines, plus one vivid anomaly (CNC-2 vibration spike two
  // nights ago) so the dashboard Machine-health card opens with a real
  // story — a live-looking open alert to ack/resolve, not an empty state.
  await query(`delete from machine_telemetry where org_id=$1 and source='seed'`, [orgId], db);
  await query(`delete from agent_actions where org_id=$1 and action_type='telemetry_anomaly' and actor='gateway' and metadata->>'seed'='1'`, [orgId], db);
  const metrics: Array<{ metric: string; base: number; jitter: number; unit: string }> = [
    { metric: 'vibration', base: 2.2, jitter: 0.35, unit: 'mm/s' },
    { metric: 'temperature', base: 68, jitter: 5, unit: '°C' },
    { metric: 'current', base: 12, jitter: 1.5, unit: 'A' },
  ];
  const machineCodes = ['CNC-1', 'CNC-2', 'Press-1', 'Assembly-1', 'Packing-1'];
  const anomalySummary = `⚠️ CNC-2: vibration 4.6mm/s — Above baseline 2.2 by 109.1% (threshold 25%)`;
  for (let day = 6; day >= 0; day--) {
    for (const m of machineCodes) {
      for (const spec of metrics) {
        const isAnomaly = m === 'CNC-2' && spec.metric === 'vibration' && day === 2;
        const value = isAnomaly ? 4.6 : Math.round((spec.base + (rnd() - 0.5) * 2 * spec.jitter) * 10) / 10;
        await query(
          `insert into machine_telemetry (org_id, machine_code, metric, value, unit, recorded_at, source)
           values ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval - ($7 || ' hours')::interval, 'seed')`,
          [orgId, m, spec.metric, value, spec.unit, String(day), String(Math.floor(rnd() * 10))]
        );
        if (isAnomaly) {
          await query(
            `insert into agent_actions (org_id, actor, action_type, entity_type, summary, reason, sources, status, metadata)
             values ($1,'gateway','telemetry_anomaly','machine',$2,'Sensor reading deviates from the machine baseline; routed to maintenance at higher urgency than routine PM',
                     '[{\"type\":\"machine\",\"label\":\"Machine CNC-2 (vibration sensor)\"}]'::jsonb,'executed',
                     jsonb_build_object('machine','CNC-2','metric','vibration','value',4.6,'deviationPct',109.1,'baseline',2.2,'seed','1'))`,
            [orgId, anomalySummary],
            db
          );
        }
      }
    }
  }
  await query(
    `insert into telemetry_baselines (org_id, machine_code, metric, baseline, threshold_pct)
     values ($1,'CNC-2','vibration',2.2,25) on conflict (org_id, machine_code, metric) do nothing`,
    [orgId],
    db
  );
  counts.telemetryReadings = 7 * 5 * 3 + 1;

  // BOMs: first two finished items consume two components each (qty per unit)
  // so the MRP engine can explode parent demand into component buy suggestions
  for (let p = 0; p < 2; p++) {
    for (let c = 0; c < 2; c++) {
      await insertEntity(
        {
          orgId,
          type: 'bom',
          code: `BOM-${itemIds[p]!.slice(0, 6)}-${c}`,
          source: 'seed',
          data: {
            parentId: itemIds[p]!,
            childId: itemIds[2 + c]!, // distinct component items
            qtyPerUnit: pick([1, 2, 4], rnd),
            scrapPct: 0,
          },
        },
        db
      );
    }
  }
  counts.boms = 4;

  return { orgId, counts };
}

/** Seed all four demo orgs. */
export async function seedAll(): Promise<Array<{ slug: string; orgId: string }>> {
  const out: Array<{ slug: string; orgId: string }> = [];
  for (const o of SEED_ORGS) {
    const { orgId } = await seedDemoData(o.slug);
    out.push({ slug: o.slug, orgId });
  }
  return out;
}

/** CLI entry: npm run seed -w @factory/db */
if (process.argv[1]?.includes('seed')) {
  seedAll()
    .then((r) => {
      console.log('seeded', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
