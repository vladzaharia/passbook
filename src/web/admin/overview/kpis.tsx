import { Link } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { MetricsOverview } from '@/shared/contracts/metrics.ts';
import { cn } from '@/web/lib/cn.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { PASS_STATUS } from '@/web/lib/status.ts';
import { EntityIcon } from '@/web/ui/index.ts';
import { chartGeometry, type Point } from './chart.tsx';
import { useRememberedCount } from './count.ts';
import { formatCount } from './format.ts';
import type { Range } from './range.ts';

export const RANGE_LABEL: Record<Range, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

/** Range-bound tiles say which range they count. */
const RANGE_SHORT: Record<Range, string> = { '24h': '24 h', '7d': '7 days', '30d': '30 days' };

/** A list a tile opens: path plus search, so the router builds the URL. */
interface Target {
  to: string;
  search?: Record<string, string>;
}

interface Kpi extends Target {
  id: string;
  label: string;
  value: number;
  icon: LucideIcon;
  series: readonly Point[];
  /** Counted over the selected range, not all time. */
  ranged?: boolean;
  /** Above zero is bad: the value and its line turn danger. */
  warn?: boolean;
}

function Sparkline({ points, warn }: { points: readonly Point[]; warn: boolean }) {
  if (points.length < 2) return null;
  const g = chartGeometry(points);
  return (
    <svg
      aria-hidden
      viewBox="0 0 600 100"
      preserveAspectRatio="none"
      className="h-8 w-full min-w-16 overflow-visible sm:w-28"
    >
      <path d={g.area} className={warn ? 'fill-danger/12' : 'fill-accent/12'} />
      <path
        d={g.line}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className={warn ? 'stroke-danger' : 'stroke-accent-fg'}
      />
    </svg>
  );
}

function Tile({ kpi, index, range }: { kpi: Kpi; index: number; range: Range }) {
  const shown = useRememberedCount(kpi.id, kpi.value);
  const bad = Boolean(kpi.warn) && kpi.value > 0;
  return (
    <li style={{ '--i': index } as CSSProperties} className="min-w-0">
      <Link
        to={kpi.to as never}
        search={kpi.search as never}
        className={cn(
          // min-h-0 opts this block link out of base.css's touch padding for inline links.
          'flex h-full min-h-0 flex-col gap-2.5 rounded-lg border border-border bg-surface-raised p-4',
          'shadow-[var(--wl-edge),var(--pk-elevation-1)] transition-[border-color] duration-(--wl-dur-hover)',
          'hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <EntityIcon
            icon={kpi.icon}
            className={cn('size-8 [&>svg]:size-4', bad && 'border-danger-border text-danger')}
          />
          <span className="min-w-0 truncate text-sm text-fg-muted">{kpi.label}</span>
          {kpi.ranged ? (
            <span className="ml-auto hidden shrink-0 text-xs text-fg-muted sm:inline">
              <span className="sr-only">, </span>
              {RANGE_SHORT[range]}
            </span>
          ) : null}
        </span>
        <span className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                'text-3xl leading-none font-semibold tracking-[-0.02em] tabular-nums',
                bad ? 'text-danger' : 'text-fg-strong',
              )}
            >
              {formatCount(shown)}
            </span>
            {/* Narrow tiles: the range sits by the value so the label keeps its room. */}
            {kpi.ranged ? (
              <span className="text-xs text-fg-muted sm:hidden">
                <span className="sr-only">, </span>
                {RANGE_SHORT[range]}
              </span>
            ) : null}
          </span>
          <Sparkline points={kpi.series} warn={bad} />
        </span>
      </Link>
    </li>
  );
}

function Secondary({
  id,
  label,
  value,
  to,
  search,
  missing,
}: Target & {
  id: string;
  label: string;
  value: number;
  missing?: boolean;
}) {
  const shown = useRememberedCount(id, value);
  return (
    <li>
      <Link
        to={to as never}
        search={search as never}
        className="inline-flex min-h-6 items-baseline gap-1.5 rounded-sm text-fg-muted hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {label}
        <span className="font-semibold text-fg tabular-nums">
          {missing ? '—' : formatCount(shown)}
        </span>
      </Link>
    </li>
  );
}

/** Four primary tiles (linked, with a sparkline), then the other counts in one quiet row. */
export function Kpis({
  data,
  range,
  enter,
}: {
  data: MetricsOverview;
  range: Range;
  enter: boolean;
}) {
  const { totals: t, series: s } = data;
  const kpis: Kpi[] = [
    {
      id: 'passes',
      label: 'Passes',
      value: t.passes,
      icon: ENTITY.pass.icon,
      series: s.issued,
      to: '/admin/passes',
    },
    {
      id: 'active',
      label: 'Active',
      value: t.activePasses,
      icon: PASS_STATUS.active.icon,
      series: s.updated,
      to: '/admin/passes',
      search: { status: 'active' },
    },
    {
      id: 'holders',
      label: 'Holders',
      value: t.holders,
      icon: ENTITY.user.icon,
      series: s.emails,
      to: '/admin/users',
    },
    {
      id: 'pushFailures',
      label: 'Push failures',
      value: t.pushFailures,
      icon: ENTITY.delivery.icon,
      series: s.pushFailures,
      to: '/admin/status',
      ranged: true,
      warn: true,
    },
  ];
  const missing = (k: keyof MetricsOverview['series']) => data.unavailable.includes(k);
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label="Totals"
        className={cn('grid grid-cols-2 gap-3 xl:grid-cols-4', enter && 'wl-stagger')}
      >
        {kpis.map((k, i) => (
          <Tile key={k.id} kpi={k} index={i} range={range} />
        ))}
      </ul>
      <div className={cn(enter && 'wl-stagger')}>
        <ul
          aria-label="More counts"
          style={{ '--i': kpis.length } as CSSProperties}
          className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 text-sm"
        >
          <Secondary
            id="voided"
            label="Voided"
            value={t.voidedPasses}
            to="/admin/passes"
            search={{ status: 'voided' }}
          />
          <Secondary id="devices" label="Devices" value={t.devices} to="/admin/passes" />
          <li aria-hidden className="h-4 w-px bg-border max-sm:hidden" />
          <li className="text-xs text-fg-muted">{RANGE_LABEL[range]}</li>
          <Secondary id="issued" label="Issued" value={t.issued} to="/admin/passes" />
          <Secondary id="updated" label="Updated" value={t.updated} to="/admin/passes" />
          <Secondary
            id="downloads"
            label="Downloads"
            value={t.downloads}
            to="/admin/passes"
            missing={missing('downloads')}
          />
        </ul>
      </div>
    </div>
  );
}
