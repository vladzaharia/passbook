import { type CSSProperties, useId } from 'react';
import type { PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import { cn } from '@/web/lib/cn.ts';
import { Badge } from '@/web/ui/index.ts';
import { type PlanView, viewOfValues } from '../../plan/limits.ts';
import { FeatureChecklist, FooterRow, LimitList } from '../../plan/plan-parts.tsx';
import { planIcon } from './plan-icons.ts';
import './plans.css';

export interface PlanTileProps {
  plan: PresetOptionDto;
  isCurrent: boolean;
  /** The Current badge arrived after an apply: it pops. */
  popCurrent: boolean;
  checked: boolean;
  /** Counts picks of this tile; each one replays the icon. */
  playKey: number;
  className?: string;
  style?: CSSProperties;
  onSelect: (preset: string) => void;
}

/**
 * One plan as a radio card: its icon and name, its limits, what it includes and its footer rule. The
 * current plan has an accent border and a badge; the pick has the ring. Explanations live in Compare.
 */
export function PlanTile({
  plan,
  isCurrent,
  popCurrent,
  checked,
  playKey,
  className,
  style,
  onSelect,
}: PlanTileProps) {
  const id = useId();
  const nameId = `${id}-name`;
  const factsId = `${id}-facts`;
  const currentId = `${id}-current`;
  const Icon = planIcon(plan.preset);
  const view: PlanView = viewOfValues(plan.values);
  return (
    <div className={cn('plan-tile relative flex', className)} style={style}>
      <div
        data-plan-tile={plan.preset}
        className={cn(
          'plan-face relative flex w-full flex-col gap-4 rounded-xl border bg-surface-raised p-4 wl-colors dark:shadow-(--wl-edge)',
          isCurrent ? 'border-accent' : 'border-border-strong hover:border-fg-muted',
          checked && 'bg-accent-subtle',
          'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
        )}
      >
        <input
          id={id}
          type="radio"
          name="plan"
          value={plan.preset}
          checked={checked}
          onChange={() => onSelect(plan.preset)}
          aria-labelledby={nameId}
          aria-describedby={isCurrent ? `${factsId} ${currentId}` : factsId}
          className="sr-only"
        />
        <span aria-hidden data-on={checked || undefined} className="plan-ring" />
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={cn(
              'inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-sunken wl-colors',
              checked || isCurrent ? 'text-accent-fg' : 'text-fg-muted',
            )}
          >
            <span
              key={playKey}
              data-plan={plan.preset}
              data-play={playKey > 0 || undefined}
              className="plan-icon inline-flex"
            >
              <Icon className="size-5" />
            </span>
          </span>
          <label
            id={nameId}
            htmlFor={id}
            className="min-w-0 flex-1 cursor-pointer truncate text-base font-semibold text-fg-strong after:absolute after:inset-0 after:rounded-xl after:content-['']"
          >
            {plan.label}
          </label>
          {isCurrent ? (
            <Badge id={currentId} tone="accent" className={popCurrent ? 'plan-pop' : undefined}>
              {PLAN_COPY.current}
            </Badge>
          ) : null}
        </div>
        <div id={factsId} className="flex flex-1 flex-col gap-4">
          <LimitList rows={view.limits} />
          <FeatureChecklist items={view.features} />
        </div>
        <FooterRow level={view.footer} />
      </div>
    </div>
  );
}
