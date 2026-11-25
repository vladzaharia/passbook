import { Check } from 'lucide-react';
import { FOOTER_SAMPLE, PLAN_COPY } from '@/shared/copy/plans.ts';
import type { FooterLevel } from '@/shared/plan-facts.ts';
import { cn } from '@/web/lib/cn.ts';
import { formatCount } from '@/web/lib/format.ts';
import { ProgressBar } from '@/web/ui/index.ts';
import type { LimitRow } from './limits.ts';

const valueText = (r: LimitRow): string => {
  if (r.limit === null)
    return r.used === null ? PLAN_COPY.noLimit : `${formatCount(r.used)} · ${PLAN_COPY.noLimit}`;
  if (r.limit === 0) return PLAN_COPY.none;
  return r.used === null
    ? formatCount(r.limit)
    : `${formatCount(r.used)} of ${formatCount(r.limit)}`;
};

/**
 * Limits as aligned rows: the name left, the number right. Where a count is kept it shows against the cap
 * with a meter. Two columns once there is room; the list reads its own width, so a tile and a page share it.
 */
export function LimitList({ rows }: { rows: readonly LimitRow[] }) {
  return (
    <div className="@container">
      <dl className="-my-1.5 grid gap-x-10 @[28rem]:grid-cols-2">
        {rows.map((r) => {
          const meter = r.used !== null && r.limit !== null && r.limit > 0;
          return (
            <div
              key={r.key}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5 py-1.5"
            >
              <dt className="truncate text-sm text-fg-muted">{r.label}</dt>
              <dd className="contents">
                <span
                  className={cn(
                    'text-right text-sm tabular-nums',
                    r.state === 'ok' ? 'font-medium text-fg-strong' : 'font-semibold text-warning',
                    r.limit === null || r.limit === 0 ? 'text-fg-muted' : undefined,
                  )}
                >
                  {valueText(r)}
                </span>
                {meter ? (
                  <span className="col-span-2">
                    <ProgressBar
                      label={r.label}
                      value={r.used ?? 0}
                      max={r.limit ?? 1}
                      valueText={valueText(r)}
                      tone={r.state === 'ok' ? 'accent' : 'warning'}
                    />
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** What a plan includes, as a short checklist. Anything it lacks is left out. */
export function FeatureChecklist({ items }: { items: readonly string[] }) {
  return (
    <div className="@container">
      <ul className="grid gap-x-8 gap-y-2 @[28rem]:grid-cols-2 @[48rem]:grid-cols-3">
        {items.map((name) => (
          <li key={name} className="flex items-center gap-2 text-sm text-fg-strong">
            <Check aria-hidden className="size-4 shrink-0 text-success" />
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The footer rule: what the smallest PassBook footer the plan allows reads as. Label over value, so tiles line up. */
export function FooterRow({ level }: { level: FooterLevel }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border pt-3">
      <span className="text-xs text-fg-muted">{PLAN_COPY.footer}</span>
      <span className="text-sm font-medium text-fg-strong">{FOOTER_SAMPLE[level]}</span>
    </div>
  );
}
