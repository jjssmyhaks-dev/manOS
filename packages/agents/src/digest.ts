import { query } from '@factory/db';
import { runMetric } from './semantic.js';
import { getPack } from '@factory/core';
import { getModelConfig } from './models.js';

/**
 * Digest agent (PRD F3): scheduled summary (sales, cash, overdue, low stock,
 * delays) via email and WhatsApp. Numbers are always computed deterministically
 * from the semantic layer; the model only writes the narrative wrapper.
 */

export interface DigestSection {
  key: string;
  title: string;
  lines: string[];
}

export interface Digest {
  orgId: string;
  asOf: string;
  sections: DigestSection[];
  narrative: string;
  channelDrafts: { whatsapp: string; email: string };
}

function inr(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export async function generateDigest(orgId: string): Promise<Digest> {
  const orgRows = await query<{ name: string; vertical: string }>(
    'select name, vertical from organizations where id=$1 limit 1', [orgId]
  );
  const org = orgRows[0] ?? { name: 'Factory', vertical: 'fabrication' };
  const pack = getPack(org.vertical);

  const sections: DigestSection[] = [];

  // sales
  const sales = await runMetric(orgId, 'sales_last_30d');
  const cash = await runMetric(orgId, 'cash_position');
  const overdue = await runMetric(orgId, 'overdue_total');
  const low = await runMetric(orgId, 'low_stock_items');
  const delayed = await runMetric(orgId, 'top_delayed_orders');

  sections.push({
    key: 'sales', title: 'Sales (30d)',
    lines: [`Order value: ${inr(sales.value ?? 0)} (as of ${sales.asOf})`],
  });
  sections.push({
    key: 'cash', title: 'Collections (30d)',
    lines: [`Payments received: ${inr(cash.value ?? 0)}`],
  });
  sections.push({
    key: 'overdue', title: 'Overdue receivables',
    lines: [
      `Total overdue: ${inr(overdue.value ?? 0)}`,
      ...(((overdue.breakdown as { lines?: Array<{ customer: string | null; amount: number; overdueDays: number }> }).lines ?? [])
        .slice(0, 3).map((l) => `• ${l.customer ?? '?'} — ${inr(l.amount)} (${l.overdueDays}d)`)),
    ],
  });
  sections.push({
    key: 'low_stock', title: 'Low stock',
    lines: (low.breakdown as Array<{ item: string | null; stockOnHand: number; reorderPoint: number; uom: string | null }>)
      .slice(0, 5).map((i) => `• ${i.item ?? '?'}: ${i.stockOnHand} ${i.uom ?? ''} (ROP ${i.reorderPoint})`),
  });
  if (pack.digestSections.includes('wip') || pack.digestSections.includes('delays')) {
    sections.push({
      key: 'wip', title: 'Open jobs & delays',
      lines: (delayed.breakdown as Array<Record<string, unknown>>).slice(0, 5)
        .map((o) => `• ${String(o.order ?? '')} — ${String(o.customer ?? '')} (qty ${String(o.qty ?? '')})`),
    });
  }
  if (pack.digestSections.includes('expiry_risk')) {
    // FMCG expiry section placeholder computed from stock ledger expiry dates
    const rows = await query<{ name: string | null; exp: string | null; qty: string | null }>(
      `select data->>'name' as name, data->>'expiryDate' as exp, qty from entities
       where org_id=$1 and type='stock_ledger' and data->>'expiryDate' is not null
         and (data->>'expiryDate')::date <= current_date + 60 limit 5`,
      [orgId]
    );
    if (rows.length) {
      sections.push({ key: 'expiry_risk', title: 'Expiry risk (60d)', lines: rows.map((r) => `• ${r.name ?? '?'} exp ${r.exp} (qty ${r.qty ?? 0})`) });
    }
  }
  if (pack.digestSections.includes('fx')) {
    const fx = await runMetric(orgId, 'fx_exposure');
    sections.push({ key: 'fx', title: 'FX exposure', lines: [JSON.stringify(fx.breakdown ?? fx.value)] });
  }

  const narrativeFallback = [
    `${org.name} — daily digest (${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})`,
    `Sales 30d ${inr(sales.value ?? 0)} · collections ${inr(cash.value ?? 0)} · overdue ${inr(overdue.value ?? 0)} · ${low.value ?? 0} low-stock items · ${delayed.value ?? 0} delayed orders.`,
  ].join('\n');

  let narrative = narrativeFallback;
  const cfg = getModelConfig();
  if (cfg.profile === 'prod' && cfg.openRouterApiKey) {
    try {
      const { generateText } = await import('ai');
      const { getModel } = await import('./models.js');
      const facts = sections.map((s) => `${s.title}: ${s.lines.join(' | ')}`).join('\n');
      const res = await generateText({
        model: getModel('fast'),
        prompt: `Write a 3-sentence WhatsApp-style business digest in Hinglish for the factory owner based strictly on these facts (do not invent numbers):\n${facts}`,
      });
      narrative = res.text || narrativeFallback;
    } catch {
      narrative = narrativeFallback;
    }
  }

  const whatsapp = [
    `🏭 *${org.name}*`,
    new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }),
    '',
    ...sections.map((s) => [`*${s.title}*`, ...s.lines].join('\n')),
  ].join('\n');

  const email = [
    `# ${org.name} — Daily digest`,
    '',
    ...sections.map((s) => [`## ${s.title}`, ...s.lines.map((l) => `- ${l}`)].join('\n')),
    '',
    narrative,
  ].join('\n');

  return { orgId, asOf: new Date().toISOString(), sections, narrative, channelDrafts: { whatsapp, email } };
}
