import { type CSSProperties, useEffect, useId, useState } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { formatCount } from './format.ts';
import './overview.css';

export interface Point {
  t: number;
  v: number;
}
export type Range = '24h' | '7d' | '30d';

/** Plot space; the svg stretches it to the box (preserveAspectRatio none, non-scaling strokes). */
const W = 600;
const H = 100;

/** Rounds up to 1, 2, 5 x 10^n so gridline labels are readable. */
export function niceMax(max: number): number {
  if (max <= 0) return 2;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  return Math.max(2, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
}

export interface Geometry {
  max: number;
  /** 0..1 across and down the plot, for the hover guide and dot. */
  fx: number[];
  fy: number[];
  line: string;
  area: string;
}

export function chartGeometry(points: readonly Point[]): Geometry {
  const max = niceMax(Math.max(0, ...points.map((p) => p.v)));
  const first = points[0]?.t ?? 0;
  const span = (points[points.length - 1]?.t ?? first) - first;
  const fx = points.map((p) => (span === 0 ? 0.5 : (p.t - first) / span));
  const fy = points.map((p) => 1 - p.v / max);
  const line = fx
    .map((x, i) => `${i === 0 ? 'M' : 'L'}${(x * W).toFixed(1)} ${((fy[i] ?? 1) * H).toFixed(1)}`)
    .join('');
  const area = fx.length
    ? `${line}L${((fx[fx.length - 1] ?? 0) * W).toFixed(1)} ${H}L${((fx[0] ?? 0) * W).toFixed(1)} ${H}Z`
    : '';
  return { max, fx, fy, line, area };
}

export function axisLabel(t: number, range: Range): string {
  const d = new Date(t);
  return range === '24h'
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Whole-number ticks only: top, middle (when whole) and zero. */
export function ticks(max: number): { f: number; label: string | null }[] {
  return [1, 0.5, 0].map((f) => ({
    f,
    label: Number.isInteger(max * f) ? formatCount(max * f) : null,
  }));
}

/** The series on screen plus the one it replaced, for a 160 ms crossfade. */
function useCrossfade(points: readonly Point[]) {
  const [state, setState] = useState({ points, key: 0, old: null as readonly Point[] | null });
  if (state.points !== points) setState({ points, key: state.key + 1, old: state.points });
  useEffect(() => {
    if (!state.old) return;
    const t = setTimeout(() => setState((s) => ({ ...s, old: null })), 160);
    return () => clearTimeout(t);
  }, [state.old]);
  return state;
}

function Series({
  points,
  gradient,
  className,
}: {
  points: readonly Point[];
  gradient: string;
  className?: string;
}) {
  const g = chartGeometry(points);
  return (
    <g className={className}>
      <path d={g.area} fill={`url(#${gradient})`} />
      <path
        d={g.line}
        fill="none"
        className="stroke-accent-fg"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

export interface ChartProps {
  title: string;
  points: readonly Point[];
  range: Range;
  /** The source cannot count this series: say so instead of drawing zeros. */
  unavailable?: boolean;
  /** Data that was loading arrived: the plot clips in once (600 ms). */
  enter?: boolean;
  /** The card's "Show data" toggle: a table replaces the plot at the same height. */
  showData?: boolean;
}

/** One series per chart: colour never carries meaning, so there is no legend. */
export function LineChart({ title, points, range, unavailable, enter, showData }: ChartProps) {
  const id = useId();
  const [hover, setHover] = useState<number>();
  const fade = useCrossfade(points);
  const geo = chartGeometry(points);
  const total = points.reduce((s, p) => s + p.v, 0);
  const peak = points.reduce<Point | undefined>((b, p) => (!b || p.v > b.v ? p : b), undefined);
  const active = hover === undefined ? undefined : points[hover];
  const empty = points.length === 0;
  const summary = unavailable
    ? `${title}: not available`
    : empty
      ? `${title}: no data`
      : `${title}: ${formatCount(total)} total${peak && peak.v > 0 ? `, peak ${formatCount(peak.v)} on ${axisLabel(peak.t, range)}` : ''}`;

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (empty || unavailable || rect.width === 0) return;
    const x = (e.clientX - rect.left) / rect.width;
    let best = 0;
    for (let i = 1; i < geo.fx.length; i++) {
      if (Math.abs((geo.fx[i] ?? 0) - x) < Math.abs((geo.fx[best] ?? 0) - x)) best = i;
    }
    setHover(best);
  }

  const readout = unavailable
    ? '—'
    : active
      ? `${axisLabel(active.t, range)}: ${formatCount(active.v)}`
      : formatCount(total);
  const at = (i: number | undefined) =>
    ({ '--fx': geo.fx[i ?? 0] ?? 0, '--fy': geo.fy[i ?? 0] ?? 1 }) as CSSProperties;

  return (
    <figure aria-labelledby={`${id}-cap`} className="m-0 flex min-w-0 flex-col gap-1">
      <figcaption id={`${id}-cap`} className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-fg-strong">{title}</span>
        <span className="text-xs text-fg-muted tabular-nums" aria-hidden>
          {readout}
        </span>
      </figcaption>
      {showData && !empty && !unavailable ? (
        <div className="h-[6.5rem] overflow-y-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 bg-surface-raised text-fg-muted">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">
                  Time
                </th>
                <th scope="col" className="px-2 py-1 text-right font-medium">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.t} className="border-t border-border">
                  <td className="px-2 py-1 text-fg">{axisLabel(p.t, range)}</td>
                  <td className="px-2 py-1 text-right text-fg tabular-nums">{formatCount(p.v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
          <div
            aria-hidden
            className="relative mt-1 h-20 min-w-6 text-right text-xs text-fg-muted tabular-nums"
          >
            {unavailable || empty
              ? null
              : ticks(geo.max).map((t) =>
                  t.label === null ? null : (
                    <span
                      key={t.f}
                      className="absolute right-0 -translate-y-1/2 leading-none"
                      style={{ top: `${(1 - t.f) * 100}%` }}
                    >
                      {t.label}
                    </span>
                  ),
                )}
          </div>
          <div
            className="wl-plot relative mt-1 h-20 touch-pan-y"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(undefined)}
          >
            <svg
              role="img"
              aria-label={summary}
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="absolute inset-0 size-full overflow-visible"
            >
              <defs>
                <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" className="[stop-color:var(--pk-accent)] [stop-opacity:0.32]" />
                  <stop offset="1" className="[stop-color:var(--pk-accent)] [stop-opacity:0]" />
                </linearGradient>
                <clipPath id={`${id}-clip`}>
                  <rect
                    x={-8}
                    y={-8}
                    width={W + 16}
                    height={H + 16}
                    className={enter ? 'wl-chart-clip' : undefined}
                  />
                </clipPath>
              </defs>
              {[0, 0.5, 1].map((f) => (
                <line
                  key={f}
                  x1={0}
                  x2={W}
                  y1={f * H}
                  y2={f * H}
                  className="stroke-border"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {unavailable || empty ? null : (
                <g clipPath={`url(#${id}-clip)`}>
                  {fade.old ? (
                    <Series points={fade.old} gradient={`${id}-fill`} className="wl-chart-out" />
                  ) : null}
                  <Series
                    key={fade.key}
                    points={fade.points}
                    gradient={`${id}-fill`}
                    className={fade.key > 0 ? 'wl-chart-in' : undefined}
                  />
                </g>
              )}
            </svg>
            {unavailable || empty ? (
              <p className="absolute inset-0 grid place-items-center text-xs text-fg-muted">
                <span className="bg-surface-raised px-2">
                  {unavailable ? 'Not available' : 'No data'}
                </span>
              </p>
            ) : null}
            {active ? (
              <span aria-hidden className="wl-plot-frame">
                <span className="wl-guide" style={at(hover)} />
                <span className="wl-dot" style={at(hover)}>
                  <span key={hover} />
                </span>
              </span>
            ) : null}
          </div>
          <span />
          <div
            aria-hidden
            className={cn(
              'mt-1 flex justify-between text-xs text-fg-muted',
              (empty || unavailable) && 'invisible',
            )}
          >
            <span>{axisLabel(points[0]?.t ?? 0, range)}</span>
            <span>{axisLabel(points[points.length - 1]?.t ?? 0, range)}</span>
          </div>
        </div>
      )}
    </figure>
  );
}
