/**
 * Agent 1 golden-question set (spec done-when: ≥30 representative questions
 * per vertical, every answer cites its source). Each case pins the EXPECTED
 * TOOL the orchestrator must route to (deterministic intent mapping); the
 * runner executes the question end-to-end against the mock model + real
 * seeded data and asserts tool choice, answer substance and source citation.
 * New: pack-specific surfaces are also pinned so a routing regression on any
 * vertical's core questions fails CI.
 */

export interface GoldenQuestion {
  q: string;
  /** tool the orchestrator must call for this question */
  tool: string;
  /** the answer must reference data from this metric/tool key (source citation) */
  expects?: string[];
  /** required in the answer text */
  includes?: string[];
}

export const GOLDEN_QUESTIONS: Record<string, GoldenQuestion[]> = {
  fabrication: [
    { q: 'What is my total sales this month?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Sales last 30 days?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Is ka mahina ka bikri batao', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'How many orders did we get last week?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Who are my top customers?', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Top 5 customers by revenue', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Sabse zyada orders kis se aaye?', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'What is my total overdue?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'Kaunse customer ka udhaar sabse zyada hai?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'Show receivables older than 45 days', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'What is the total receivables balance?', tool: 'query_data', expects: ['receivables_total'] },
    { q: 'How much cash did we collect this month?', tool: 'query_data', expects: ['cash_position'] },
    { q: 'Collections this month?', tool: 'query_data', expects: ['cash_position'] },
    { q: 'What is the stock of MS Bracket 200mm?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'MS Bracket 200mm kitna stock hai?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'Do we have enough SS Enclosure 4U in stock?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'Stock valuation kitna hai?', tool: 'query_data', expects: ['stock_value'] },
    { q: 'Which items are below reorder point?', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Low stock report', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Kya koi item reorder ke neeche hai?', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'What needs reordering this week?', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'What is my WIP right now?', tool: 'query_data', expects: ['open_job_cards'] },
    { q: 'Show open job cards', tool: 'query_data', expects: ['open_job_cards'] },
    { q: 'Which orders are delayed?', tool: 'query_data', expects: ['top_delayed_orders'] },
    { q: 'Late delivery ke orders kaunse hain?', tool: 'query_data', expects: ['top_delayed_orders'] },
    { q: 'Draft payment reminders for overdue invoices', tool: 'draft_reminders', expects: ['draft_reminders'] },
    { q: 'Send reminders to everyone overdue more than 30 days', tool: 'draft_reminders', expects: ['draft_reminders'] },
    { q: 'Draft RFQs for the low stock items', tool: 'draft_rfq', expects: ['draft_rfq'] },
    { q: 'Create a PO of 100 nos MS Bracket 200mm from Sharma at 240', tool: 'create_po_draft', expects: ['create_po_draft'] },
    { q: 'Raise PO for Conveyor Roller from Gupta Metals, 50 nos at 900', tool: 'create_po_draft', expects: ['create_po_draft'] },
  ],
  fmcg: [
    { q: 'What is my total sales this month?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Sales last 30 days?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Is mahine ki bikri batao', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'How many orders did we get this week?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Top distributors by sales', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Who are my top customers?', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Secondary sales kaisa chal raha hai?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Total overdue receivables?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'Which distributor payments are overdue?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: ' Udhaar 45 din se zyada wale', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'Total outstanding balance?', tool: 'query_data', expects: ['receivables_total'] },
    { q: 'Cash collected this month?', tool: 'query_data', expects: ['cash_position'] },
    { q: 'Payments received in the last 30 days?', tool: 'query_data', expects: ['cash_position'] },
    { q: 'Stock of Masala Packet 100g?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'Atta 5kg ka stock batao', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'How many Pickle Jar 500g do we have?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'Inventory value?', tool: 'query_data', expects: ['stock_value'] },
    { q: 'Which SKUs are below reorder point?', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Low stock items?', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Packaging material restock list', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Which batches expire in the next 60 days?', tool: 'expiry_report', expects: ['expiry_report'] },
    { q: 'Expiry risk report', tool: 'expiry_report', expects: ['expiry_report'] },
    { q: 'Best-before 60 din ke andar kya expire hoga?', tool: 'expiry_report', expects: ['expiry_report'] },
    { q: 'Which orders are delayed?', tool: 'query_data', expects: ['top_delayed_orders'] },
    { q: 'Open production jobs?', tool: 'query_data', expects: ['open_job_cards'] },
    { q: 'Draft payment reminders', tool: 'draft_reminders', expects: ['draft_reminders'] },
    { q: 'Remind everyone overdue over 30 days', tool: 'draft_reminders', expects: ['draft_reminders'] },
    { q: 'Draft RFQs for low stock', tool: 'draft_rfq', expects: ['draft_rfq'] },
    { q: 'Create a PO of 200 nos Atta 5kg from Sharma Suppliers at 180', tool: 'create_po_draft', expects: ['create_po_draft'] },
    { q: 'Raise PO for Juice Bottle 1L from Gupta Traders, 100 nos at 95', tool: 'create_po_draft', expects: ['create_po_draft'] },
  ],
  scrap: [
    { q: 'What is my total sales this month?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Purchases this month?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Is mahine ki kharidari batao', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'How many orders last week?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Top buyers this month?', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Sabse bada customer kaun hai?', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Sales by customer for the last 30 days', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'What do sellers owe us / seller payables?', tool: 'query_data', expects: ['receivables_total'] },
    { q: 'Overdue receivables?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'Pending payments from buyers?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'Total outstanding?', tool: 'query_data', expects: ['receivables_total'] },
    { q: 'Cash position this month?', tool: 'query_data', expects: ['cash_position'] },
    { q: 'Collections 30 din mein?', tool: 'query_data', expects: ['cash_position'] },
    { q: 'Stock of Copper Wire Scrap?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'MS Turnings ka stock?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'How much Aluminium Sheet Lot is on hand?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'Yard valuation?', tool: 'query_data', expects: ['stock_value'] },
    { q: 'Which materials are below reorder point?', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Low stock report', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Kya reorder karna hai?', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'What is my yield this month?', tool: 'yield_report', expects: ['yield_report'] },
    { q: 'Input vs output weight report', tool: 'yield_report', expects: ['yield_report'] },
    { q: 'Recovery percentage kaisa hai?', tool: 'yield_report', expects: ['yield_report'] },
    { q: 'Which orders are delayed?', tool: 'query_data', expects: ['top_delayed_orders'] },
    { q: 'Open job cards?', tool: 'query_data', expects: ['open_job_cards'] },
    { q: 'Draft payment reminders', tool: 'draft_reminders', expects: ['draft_reminders'] },
    { q: 'Remind buyers overdue 30+ days', tool: 'draft_reminders', expects: ['draft_reminders'] },
    { q: 'Draft RFQs', tool: 'draft_rfq', expects: ['draft_rfq'] },
    { q: 'Create a PO of 500 kg Copper Wire Scrap from Ramesh at 620', tool: 'create_po_draft', expects: ['create_po_draft'] },
    { q: 'Raise PO for Paper Bales from Gupta Recyclers, 1000 kg at 12', tool: 'create_po_draft', expects: ['create_po_draft'] },
  ],
  exports: [
    { q: 'What is my total sales this month?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Sales last 30 days?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Is mahine ki bikri?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'How many orders this week?', tool: 'sales_summary', expects: ['sales_summary'] },
    { q: 'Top buyers by revenue?', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Who are my best customers?', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Sabse zyada order kisse aaya?', tool: 'query_data', expects: ['sales_by_customer_30d'] },
    { q: 'Overdue export invoices?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'Which buyer payments are pending?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: '45 din se zyada udhaar?', tool: 'list_overdue', expects: ['list_overdue'] },
    { q: 'Total receivables?', tool: 'query_data', expects: ['receivables_total'] },
    { q: 'Cash collected this month?', tool: 'query_data', expects: ['cash_position'] },
    { q: 'Realisation this month?', tool: 'query_data', expects: ['cash_position'] },
    { q: 'Stock of Cotton Shirt Lot?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'Home Linen Set ka stock?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'How many Leather Wallet Lots are ready?', tool: 'get_item_stock', expects: ['get_item_stock'] },
    { q: 'Inventory value?', tool: 'query_data', expects: ['stock_value'] },
    { q: 'Which items are below reorder point?', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Low stock report', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'Packing material restock list', tool: 'reorder_check', expects: ['reorder_check'] },
    { q: 'What is my FX exposure?', tool: 'fx_exposure', expects: ['fx_exposure'] },
    { q: 'Forex exposure on open invoices?', tool: 'fx_exposure', expects: ['fx_exposure'] },
    { q: 'Dollar exposure kitna hai?', tool: 'fx_exposure', expects: ['fx_exposure'] },
    { q: 'Shipping document status — packing lists and LUT?', tool: 'export_docs_status', expects: ['export_docs_status'] },
    { q: 'Which export documents are pending?', tool: 'export_docs_status', expects: ['export_docs_status'] },
    { q: 'Draft payment reminders', tool: 'draft_reminders', expects: ['draft_reminders'] },
    { q: 'Remind buyers overdue over 30 days', tool: 'draft_reminders', expects: ['draft_reminders'] },
    { q: 'Draft RFQs for low stock', tool: 'draft_rfq', expects: ['draft_rfq'] },
    { q: 'Create a PO of 300 nos Jute Bag Lot from Sharma Mills at 140', tool: 'create_po_draft', expects: ['create_po_draft'] },
    { q: 'Raise PO for Ceramic Mug Lot from Gupta Traders, 500 nos at 85', tool: 'create_po_draft', expects: ['create_po_draft'] },
  ],
};

/** Count sanity: the spec requires ≥30 per vertical. */
export const GOLDEN_QUESTION_COUNTS: Record<string, number> = Object.fromEntries(
  Object.entries(GOLDEN_QUESTIONS).map(([k, v]) => [k, v.length])
);
