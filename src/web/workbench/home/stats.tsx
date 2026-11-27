import { Link } from '@tanstack/react-router';
import { WB_HOME_COPY as C } from '../../../shared/copy/workbench-home.ts';
import { type WbTool, wbPath } from '../../../shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import { CARD_SURFACE } from '../../ui/card.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import type { Summary } from './data.ts';

interface Stat {
  label: string;
  value: number;
  limit?: number | null;
  tool: WbTool;
  query?: Record<string, string>;
  /** Something that asks for a look: toned. */
  alert?: boolean;
}

/** A sandbox holds a plan's caps, so its four are what it holds against them; an org's are what asks for a look. */
export function statsOf(s: Summary): Stat[] {
  if (s.quotas) {
    const q = s.quotas;
    return [
      { label: C.stats.passes, value: q.passes.used, limit: q.passes.limit, tool: 'passes' },
      {
        label: C.stats.templates,
        value: q.templates.used,
        limit: q.templates.limit,
        tool: 'design',
      },
      {
        label: C.stats.endpoints,
        value: q.endpoints.used,
        limit: q.endpoints.limit,
        tool: 'events',
      },
      { label: C.stats.keys, value: q.keys.used, limit: q.keys.limit, tool: 'keys' },
    ];
  }
  return [
    { label: C.stats.errors, value: s.errors, tool: 'logs', query: { status: '4xx' }, alert: true },
    { label: C.stats.failed, value: s.failedDeliveries, tool: 'events', alert: true },
    { label: C.stats.inbox, value: s.inboxNew, tool: 'inbox' },
    { label: C.stats.expiring, value: s.keysExpiring, tool: 'keys', alert: true },
  ];
}

const meter = (n: number, limit: number | null | undefined) =>
  limit ? Math.min(100, Math.round((n / limit) * 100)) : 0;

export function Stats({ orgId, summary }: { orgId: string; summary: Summary | undefined }) {
  if (!summary)
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="status" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
      {statsOf(summary).map((s) => {
        const hot = s.alert && s.value > 0;
        const full = s.limit != null && s.value >= s.limit;
        return (
          <li key={s.label}>
            <Link
              to={wbPath(orgId, s.tool, s.query ? { query: s.query } : {})}
              className={cn(
                CARD_SURFACE,
                'group flex h-full min-h-20 flex-col justify-between gap-2 p-3 outline-none transition-[border-color] duration-(--wl-dur-hover) ease-(--wl-ease-move) hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              )}
            >
              <span className="text-xs font-medium text-fg-muted">{s.label}</span>
              <span className="flex items-baseline gap-1.5">
                <span
                  className={cn(
                    'font-mono text-2xl font-semibold tabular-nums',
                    hot ? 'text-danger' : 'text-fg-strong',
                  )}
                >
                  {s.value}
                </span>
                {s.limit != null ? (
                  <span className="font-mono text-xs text-fg-muted">{C.stats.of(s.limit)}</span>
                ) : null}
              </span>
              {s.limit ? (
                <span
                  aria-hidden
                  className="wb-home-meter block h-1 overflow-hidden rounded-full bg-state-hover-tint"
                >
                  <i
                    className={cn('block h-full rounded-full', full ? 'bg-warning' : 'bg-accent')}
                    style={{ width: `${meter(s.value, s.limit)}%` }}
                  />
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
