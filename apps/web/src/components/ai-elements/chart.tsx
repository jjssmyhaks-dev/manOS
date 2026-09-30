'use client';

/**
 * Vercel AI Elements — Chart
 * A tiny inline bar chart for tool results (ask_data / grouped metrics).
 * Pure SVG, no chart library: renders label + value rows as horizontal bars
 * sized to the max value, with INR-friendly number formatting.
 */

export interface ChartRow {
  label: string;
  value: number;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-IN');
  return String(Math.round(n * 100) / 100);
}

export function Chart({ rows, title, className }: { rows: ChartRow[]; title?: string; className?: string }) {
  const data = rows.slice(0, 8);
  if (data.length === 0) return null;
  const max = Math.max(...data.map((r) => Math.abs(r.value)), 1);
  const countMetric = data.every((r) => Number.isInteger(r.value)) && max < 1000;

  return (
    <div className={`rounded-lg border bg-background/60 px-3 py-2 ${className ?? ''}`}>
      {title && <div className="mb-1 text-[11px] font-medium text-muted-foreground">{title}</div>}
      <div className="space-y-1.5">
        {data.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground" title={r.label}>{r.label}</span>
            <span className="h-3 min-w-[2px] rounded-sm bg-primary/70" style={{ width: `${Math.max(2, (Math.abs(r.value) / max) * 60)}%` }} />
            <span className="shrink-0 text-[11px] font-medium">{countMetric ? r.value.toLocaleString('en-IN') : fmt(r.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Best-effort: does this tool output look like a grouped chartable result? */
export function chartRowsFromToolOutput(output: unknown): ChartRow[] | null {
  if (!output || typeof output !== 'object') return null;
  const rows = (output as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cleaned: ChartRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') return null;
    const label = (r as { label?: unknown }).label;
    const value = (r as { value?: unknown }).value;
    if (typeof label !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) return null;
    cleaned.push({ label, value });
  }
  return cleaned.length ? cleaned : null;
}
