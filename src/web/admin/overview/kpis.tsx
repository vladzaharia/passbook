import { Link } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { MetricsOverview } from '@/shared/contracts/metrics.ts';
import { cn } from '@/web/lib/cn.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { PASS_STATUS } from '@/web/lib/status.ts';
import { EntityIcon } from '@/web/ui/index.ts';
import { formatCount } from '../../lib/format.ts';
import { chartGeometry, type Point } from './chart.tsx';
import { useRememberedCount } from './count.ts';
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
  /** A tenant list of an org the admin is not a member of is Forbidden: the number stays plain. */
  plain?: boolean;
}

function TargetLink({
  to,
  search,
  plain,
  className,
  children,
}: Target & { className: string; children: React.ReactNode }) {
  if (plain) return <div className={className}>{children}</div>;
  return (
    <Link to={to} search={search} className={className}>
      {children}
    </Link>
  );
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

function Tile({
  kpi,
  index,
  range,
  countScope,
}: {
  kpi: Kpi;
  index: number;
  range: Range;
  countScope: string;
}) {
  const shown = useRememberedCount(`${countScope}:${kpi.id}`, kpi.value);
  const bad = Boolean(kpi.warn) && kpi.value > 0;
  return (
    <li style={{ '--i': index } as CSSProperties} className="min-w-0">
      <TargetLink
        to={kpi.to}
        search={kpi.search}
        plain={kpi.plain}
        className={cn(
          // min-h-0 opts this block link out of base.css's touch padding for inline links.
          'flex h-full min-h-0 flex-col gap-2.5 rounded-lg border border-border bg-surface-raised p-4',
          'shadow-[var(--wl-edge),var(--pk-elevation-1)] transition-[border-color] duration-(--wl-dur-hover)',
          'hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <EntityIcon icon={kpi.icon} className={cn(bad && 'border-danger-border text-danger')} />
          <span className="min-w-0 text-sm text-fg-muted">{kpi.label}</span>
          {kpi.ranged ? (
            <span className="ml-auto hidden shrink-0 text-xs text-fg-muted sm:inline">
              <span className="sr-only">, </span>
              {RANGE_SHORT[range]}
            </span>
          ) : null}
        </span>
        {/* Flex hides the gap from the accessible name: keep a space between label and value. */}{' '}
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
      </TargetLink>
    </li>
  );
}

function Secondary({
  id,
  label,
  value,
  to,
  search,
  plain,
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
      <TargetLink
        to={to}
        search={search}
        plain={plain}
        className="inline-flex min-h-6 items-center gap-1.5 rounded-sm text-fg-muted pointer-coarse:min-h-11 hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {label}
        <span className="font-semibold text-fg tabular-nums">
          {missing ? '—' : formatCount(shown)}
        </span>
      </TargetLink>
    </li>
  );
}

/** Four primary tiles (linked, with a sparkline), then the other counts in one quiet row. */
export function Kpis({
  data,
  range,
  enter,
  countScope,
  listOrgId,
}: {
  data: MetricsOverview;
  range: Range;
  enter: boolean;
  countScope: string;
  /** The filtered org when the admin is a member of it, `null` when not; absent: no filter. */
  listOrgId?: string | null;
}) {
  const { totals: t, series: s } = data;
  const passes = (search?: Record<string, string>): Pick<Target, 'search' | 'plain'> => ({
    search: listOrgId ? { ...search, orgId: listOrgId } : search,
    plain: listOrgId === null,
  });
  const kpis: Kpi[] = [
    {
      id: 'passes',
      label: 'Passes',
      value: t.passes,
      icon: ENTITY.pass.icon,
      series: s.issued,
      to: '/admin/passes',
      ...passes(),
    },
    {
      id: 'active',
      label: 'Active',
      value: t.activePasses,
      icon: PASS_STATUS.active.icon,
      series: s.updated,
      to: '/admin/passes',
      ...passes({ status: 'active' }),
    },
    {
      id: 'holders',
      label: 'Passes with holder email',
      value: t.holders,
      icon: ENTITY.user.icon,
      series: s.emails,
      to: '/admin/passes',
      ...passes(),
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
          <Tile key={k.id} kpi={k} index={i} range={range} countScope={countScope} />
        ))}
      </ul>
      <div className={cn(enter && 'wl-stagger')}>
        <ul
          aria-label="More counts"
          style={{ '--i': kpis.length } as CSSProperties}
          className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 text-sm"
        >
          <Secondary
            id={`${countScope}:voided`}
            label="Voided"
            value={t.voidedPasses}
            to="/admin/passes"
            {...passes({ status: 'voided' })}
          />
          <Secondary
            id={`${countScope}:devices`}
            label="Devices"
            value={t.devices}
            to="/admin/passes"
            {...passes()}
          />
          <li aria-hidden className="h-4 w-px bg-border max-sm:hidden" />
          <li className="text-xs text-fg-muted">{RANGE_LABEL[range]}</li>
          <li className="text-fg-muted">
            Email outcomes: Unknown (needs review){' '}
            <span className="font-semibold text-fg tabular-nums">
              {formatCount(t.emailUnknown)}
            </span>
          </li>
          <Secondary
            id={`${countScope}:issued`}
            label="Issued"
            value={t.issued}
            to="/admin/passes"
            {...passes()}
          />
          <Secondary
            id={`${countScope}:updated`}
            label="Updated"
            value={t.updated}
            to="/admin/passes"
            {...passes()}
          />
          <Secondary
            id={`${countScope}:downloads`}
            label="Downloads"
            value={t.downloads}
            to="/admin/passes"
            {...passes()}
            missing={missing('downloads')}
          />
        </ul>
      </div>
    </div>
  );
}
