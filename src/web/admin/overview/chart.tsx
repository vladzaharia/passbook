import { useId, useState } from 'react';
import { formatCount } from './format.ts';

export interface Point {
  t: number;
  v: number;
}

const W = 640;
const H = 160;
const PAD = { l: 40, r: 8, t: 8, b: 20 };

/** Rounds up to 1, 2, 5 x 10^n so gridline labels are readable. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export interface Geometry {
  max: number;
  xs: number[];
  ys: number[];
  line: string;
  area: string;
}

export function chartGeometry(points: readonly Point[]): Geometry {
  const max = niceMax(Math.max(0, ...points.map((p) => p.v)));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const first = points[0]?.t ?? 0;
  const span = (points[points.length - 1]?.t ?? first) - first;
  const xs = points.map((p) => PAD.l + (span === 0 ? innerW / 2 : ((p.t - first) / span) * innerW));
  const ys = points.map((p) => PAD.t + innerH - (p.v / max) * innerH);
  const line = xs
    .map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${ys[i]?.toFixed(1)}`)
    .join('');
  const base = PAD.t + innerH;
  const area = xs.length
    ? `${line}L${xs[xs.length - 1]?.toFixed(1)} ${base}L${xs[0]?.toFixed(1)} ${base}Z`
    : '';
  return { max, xs, ys, line, area };
}

function label(t: number, range: '24h' | '7d' | '30d'): string {
  const d = new Date(t);
  return range === '24h'
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export interface ChartProps {
  title: string;
  points: readonly Point[];
  range: '24h' | '7d' | '30d';
}

/** One series per chart: colour never carries meaning, so there is no legend. */
export function LineChart({ title, points, range }: ChartProps) {
  const id = useId();
  const [hover, setHover] = useState<number>();
  const total = points.reduce((s, p) => s + p.v, 0);
  const peak = points.reduce<Point | undefined>(
    (best, p) => (!best || p.v > best.v ? p : best),
    undefined,
  );
  const geo = chartGeometry(points);
  const active = hover === undefined ? undefined : points[hover];
  const summary =
    points.length === 0
      ? `${title}: no data`
      : `${title}: ${formatCount(total)} total${peak && peak.v > 0 ? `, peak ${formatCount(peak.v)} on ${label(peak.t, range)}` : ''}`;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (points.length === 0 || rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < geo.xs.length; i++) {
      if (Math.abs((geo.xs[i] ?? 0) - x) < Math.abs((geo.xs[best] ?? 0) - x)) best = i;
    }
    setHover(best);
  }

  return (
    <figure aria-labelledby={`${id}-cap`} className="m-0 flex flex-col gap-2">
      <figcaption id={`${id}-cap`} className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-fg-strong">{title}</span>
        <span className="text-xs text-fg-muted" aria-hidden>
          {active ? `${label(active.t, range)}: ${formatCount(active.v)}` : formatCount(total)}
        </span>
      </figcaption>
      {points.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">No data</p>
      ) : (
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(undefined)}
        >
          {[0, 0.5, 1].map((f) => {
            const y = PAD.t + (H - PAD.t - PAD.b) * (1 - f);
            return (
              <g key={f}>
                <line
                  x1={PAD.l}
                  x2={W - PAD.r}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={PAD.l - 6}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-fg-muted text-[11px]"
                >
                  {formatCount(Math.round(geo.max * f))}
                </text>
              </g>
            );
          })}
          <path d={geo.area} className="fill-accent-subtle" />
          <path
            d={geo.line}
            fill="none"
            className="stroke-accent-fg"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {active ? (
            <circle
              cx={geo.xs[hover ?? 0]}
              cy={geo.ys[hover ?? 0]}
              r={4}
              className="fill-accent-fg"
            />
          ) : null}
          <text x={PAD.l} y={H - 4} className="fill-fg-muted text-[11px]">
            {label(points[0]?.t ?? 0, range)}
          </text>
          <text x={W - PAD.r} y={H - 4} textAnchor="end" className="fill-fg-muted text-[11px]">
            {label(points[points.length - 1]?.t ?? 0, range)}
          </text>
        </svg>
      )}
      {points.length > 0 ? (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">Data for {title}</summary>
          <table className="mt-1 w-full text-left">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.t}>
                  <td>{new Date(p.t).toLocaleString()}</td>
                  <td>{formatCount(p.v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </figure>
  );
}
