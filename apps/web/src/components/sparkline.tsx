/**
 * Dependency-free SVG sparkline for trend rows (pilot cockpit trajectory).
 * Server-safe pure component; nulls are skipped, <2 points renders a flat
 * placeholder so an empty/short history never breaks the layout.
 */
export function Sparkline({
  values,
  width = 76,
  height = 22,
  stroke,
  fill,
  className,
}: {
  values: Array<number | null>;
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  className?: string;
}) {
  const pts = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const color = stroke ?? '#0ea5e9';

  if (pts.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
        <line x1={2} y1={height / 2} x2={width - 2} y2={height / 2} stroke="#d4d4d8" strokeWidth={1.5} strokeDasharray="3 3" />
      </svg>
    );
  }

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1; // flat series still draws a mid line
  const pad = 2;
  const step = (width - pad * 2) / (values.length - 1);

  // index-based x so skipped nulls don't compress the timeline shape
  let path = '';
  let firstX = 0;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    const x = pad + i * step;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    if (!path) {
      firstX = x;
    }
    path += `${path ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  let lastIdx = -1;
  let lastVal = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      lastIdx = i;
      lastVal = v;
      break;
    }
  }
  const lastY = height - pad - ((lastVal - min) / span) * (height - pad * 2);
  const lastX = pad + lastIdx * step;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {fill ? <path d={`${path} L${lastX},${height - 1} L${firstX},${height - 1} Z`} fill={fill} stroke="none" opacity={0.4} /> : null}
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2} fill={color} />
    </svg>
  );
}
