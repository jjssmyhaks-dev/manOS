import type { ApprovalDecision } from '@factory/db';

/**
 * Vertical packs (PRD C-5): one core, four configurations. A pack is
 * configuration — item taxonomy, document templates, checklists, KPIs, agent
 * prompts and enabled tools — never a fork of the codebase.
 */

export type Vertical = 'fabrication' | 'fmcg' | 'scrap' | 'exports';

export interface KpiDef {
  key: string;
  label: string;
  description: string;
}

export interface ChecklistDef {
  key: string;
  label: string;
  items: string[];
}

export interface VerticalPack {
  key: Vertical;
  label: string;
  description: string;
  /** Item taxonomy roots offered in onboarding and used by agents. */
  itemCategories: string[];
  /** Document templates the doc-intake agent can produce. */
  docTemplates: string[];
  /** Extra record types this pack enables on top of core. */
  extraEntityTypes: string[];
  /** Enabled agent tool names for this pack. */
  tools: string[];
  kpis: KpiDef[];
  checklists: ChecklistDef[];
  /** Extra system-prompt guidance for the orchestrator. */
  promptGuidance: string;
  /** Digest sections shown for this pack. */
  digestSections: string[];
}

const COMMON_TOOLS = [
  'query_data',
  'remember',
  'list_overdue',
  'get_item_stock',
  'sales_summary',
  'reorder_check',
  'run_mrp',
  'explain_metric',
  // write tools — every pack can draft actions; the policy engine governs them
  'draft_reminders',
  'draft_reminders_batch',
  'draft_rfq',
  'create_po_draft',
  'compare_vendor_quotes',
  // A9/A11/A13 agent surfaces (quality, forecasting, maintenance) — every
  // vertical inspects, forecasts and maintains machines
  'forecast_reorder_points',
  'log_inspection',
  'log_defect_ncr',
  'check_maintenance',
  'draft_maintenance_wo',
];

const FABRICATION: VerticalPack = {
  key: 'fabrication',
  label: 'Fabrication / Job-shop',
  description: 'Multi-level BOM, routing and job cards, job-work challans, scrap %, drawings.',
  itemCategories: ['Raw Material', 'Semi-finished', 'Finished Component', 'Consumable'],
  docTemplates: ['Sales Order', 'Job Card', 'Job-work Challan', 'Quotation'],
  extraEntityTypes: ['job_card', 'work_order', 'routing_step'],
  tools: [...COMMON_TOOLS, 'create_job_card', 'log_shift_output'],
  kpis: [
    { key: 'otif', label: 'OTIF %', description: 'Orders dispatched on time, in full' },
    { key: 'scrap_pct', label: 'Scrap %', description: 'Material scrapped vs issued' },
    { key: 'wip_value', label: 'WIP value', description: 'Value locked in work in progress' },
  ],
  checklists: [
    { key: 'dispatch_qc', label: 'Dispatch QC', items: ['Dimensions ok', 'Surface finish', 'Paint/coating', 'Packing'] },
  ],
  promptGuidance:
    'This factory is a fabrication/job-shop. Speak in terms of job cards, WIP, routing steps and scrap percentage. Job-work (subcontract) challans are common — track material going out and coming back.',
  digestSections: ['sales', 'cash', 'overdue', 'low_stock', 'wip', 'delays'],
};

const FMCG: VerticalPack = {
  key: 'fmcg',
  label: 'FMCG',
  description: 'Batch/lot and expiry, distributor schemes, secondary sales, FSSAI-style checklists.',
  itemCategories: ['SKU', 'Packaging Material', 'Raw Ingredient'],
  docTemplates: ['Sales Order', 'Delivery Challan', 'Distributor Invoice'],
  extraEntityTypes: ['batch', 'distributor'],
  tools: [...COMMON_TOOLS, 'expiry_report'],
  kpis: [
    { key: 'expiry_risk', label: 'Expiry risk', description: 'Stock expiring within 60 days' },
    { key: 'fill_rate', label: 'Fill rate %', description: 'Order lines shipped complete' },
    { key: 'scheme_cost', label: 'Scheme cost', description: 'Trade scheme spend' },
  ],
  checklists: [
    { key: 'fssai_batch', label: 'Batch release (FSSAI-style)', items: ['Label check', 'Batch code printed', 'Seal integrity', 'Best-before date'] },
  ],
  promptGuidance:
    'This factory is FMCG. Always mention batch/lot and expiry dates for stock answers. Distributors and trade schemes matter; secondary sales visibility is a goal.',
  digestSections: ['sales', 'cash', 'overdue', 'low_stock', 'expiry_risk'],
};

const SCRAP: VerticalPack = {
  key: 'scrap',
  label: 'Scrap / Waste',
  description: 'Weighbridge tickets, grade-based rates, many-small-seller purchasing, yield tracking.',
  itemCategories: ['Ferrous', 'Non-ferrous', 'Paper', 'Plastic', 'E-waste'],
  docTemplates: ['Purchase Ticket', 'Weighbridge Slip', 'Seller Payment Voucher'],
  extraEntityTypes: ['weighbridge_ticket', 'seller'],
  tools: [...COMMON_TOOLS, 'weighbridge_entry', 'yield_report'],
  kpis: [
    { key: 'yield_pct', label: 'Yield %', description: 'Output weight vs input weight' },
    { key: 'avg_purchase_rate', label: 'Avg purchase ₹/kg', description: 'Grade-based average buying rate' },
    { key: 'seller_payables', label: 'Seller payables', description: 'Unpaid small sellers' },
  ],
  checklists: [
    { key: 'gate_entry', label: 'Gate entry', items: ['Vehicle number', 'Gross weight', 'Tare weight', 'Grade verified'] },
  ],
  promptGuidance:
    'This factory trades scrap/waste. Every purchase starts with a weighbridge ticket: gross, tare, net weight and grade-based rate. Many small sellers; track their payables carefully.',
  digestSections: ['purchases', 'sales', 'cash', 'overdue', 'yield'],
};

const EXPORTS: VerticalPack = {
  key: 'exports',
  label: 'Exports',
  description: 'Proforma/commercial invoice, packing list, LUT/IEC, buyer follow-ups, FX exposure.',
  itemCategories: ['Export SKU', 'Packing Material'],
  docTemplates: ['Proforma Invoice', 'Commercial Invoice', 'Packing List', 'Shipping Bill'],
  extraEntityTypes: ['shipment'],
  tools: [...COMMON_TOOLS, 'fx_exposure', 'export_docs_status'],
  kpis: [
    { key: 'realisation_inr', label: 'Realisation ₹', description: 'INR received vs invoiced' },
    { key: 'doc_cycle_days', label: 'Doc cycle days', description: 'Order to shipping documents ready' },
    { key: 'fx_exposure', label: 'FX exposure', description: 'Open forex exposure' },
  ],
  checklists: [
    { key: 'pre_shipment', label: 'Pre-shipment', items: ['Commercial invoice', 'Packing list', 'LUT/IEC valid', 'Buyer docs'] },
  ],
  promptGuidance:
    'This factory exports. Quotes are proforma invoices; track packing lists, LUT/IEC validity and buyer payment follow-ups. FX exposure on open invoices matters.',
  digestSections: ['sales', 'cash', 'overdue', 'shipments', 'fx'],
};

export const VERTICAL_PACKS: Record<Vertical, VerticalPack> = {
  fabrication: FABRICATION,
  fmcg: FMCG,
  scrap: SCRAP,
  exports: EXPORTS,
};

export function getPack(vertical: string): VerticalPack {
  return VERTICAL_PACKS[vertical as Vertical] ?? FABRICATION;
}

/** Action types the policy engine knows; packs can extend with new types. */
export const ACTION_TYPES = [
  'send_reminder',
  'send_reminder_batch',
  'send_rfq',
  'create_po',
  'so_create',
  'tally_push',
  'digest_send',
  'whatsapp_send',
  'email_send',
  'grn_create',
  'job_card_update',
  'create_ncr',
  'create_maintenance_wo',
  'update_reorder_points',
] as const satisfies readonly string[];

export function policyDefaults(): Record<string, { decision: ApprovalDecision; note: string }> {
  const d: Record<string, { decision: ApprovalDecision; note: string }> = {};
  for (const a of ACTION_TYPES) d[a] = { decision: 'ask', note: 'default ask: human approves outbound/writes' };
  d['digest_send'] = { decision: 'auto', note: 'digests are informational' };
  d['job_card_update'] = { decision: 'ask', note: 'operational logging — low-trust-risk orgs may set auto' };
  d['update_reorder_points'] = { decision: 'ask', note: 'batched forecast writes — review before applying' };
  return d;
}
