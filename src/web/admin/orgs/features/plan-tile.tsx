import { type CSSProperties, useId } from 'react';
import type { PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import type { PlanFacts } from '@/shared/plan-facts.ts';
import { cn } from '@/web/lib/cn.ts';
import { Badge } from '@/web/ui/index.ts';
import { ChannelChips } from './plan-channels.tsx';
import { PlanNumber } from './plan-count.tsx';
import { FooterSample, PlanFooterInfo } from './plan-footer-popover.tsx';
import { planIcon } from './plan-icons.ts';
import './plans.css';

export interface PlanTileProps {
  plan: PresetOptionDto;
  facts: PlanFacts;
  /** The org's plan now, for the numbers a pick counts from. */
  from: PlanFacts | undefined;
  isCurrent: boolean;
  /** The Current badge arrived after an apply: it pops. */
  popCurrent: boolean;
  checked: boolean;
  /** Counts picks of this tile; each one replays the icon and the numbers. */
  playKey: number;
  /** The org's name where it is known: the email sender row reads it. */
  orgName?: string;
  className?: string;
  style?: CSSProperties;
  onSelect: (preset: string) => void;
}

function Count({
  value,
  from,
  playKey,
  unit,
  none,
  noLimit,
}: {
  value: number | null;
  from: number | null | undefined;
  playKey: number;
  unit: string;
  none: string;
  noLimit: string;
}) {
  if (value === 0) return <span className="text-sm font-medium text-fg-muted">{none}</span>;
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-lg font-semibold text-fg-strong">
        <PlanNumber value={value} from={from} playKey={playKey} />
      </span>
      {value === null ? <span className="sr-only">{noLimit}</span> : null}
      <span aria-hidden={value === null || undefined} className="text-xs text-fg-muted">
        {unit}
      </span>
    </span>
  );
}

/**
 * One plan as a radio card: icon, name, four facts computed from its values. The info button is a sibling
 * of the label, over the footer row, so it never selects the card and is not nested in a label.
 */
export function PlanTile({
  plan,
  facts,
  from,
  isCurrent,
  popCurrent,
  checked,
  playKey,
  orgName,
  className,
  style,
  onSelect,
}: PlanTileProps) {
  const id = useId();
  const nameId = `${id}-name`;
  const factsId = `${id}-facts`;
  const currentId = `${id}-current`;
  const Icon = planIcon(plan.preset);
  return (
    <div className={cn('@container/plan relative flex', className)} style={style}>
      <label
        htmlFor={id}
        className={cn(
          'relative flex w-full cursor-pointer flex-col gap-3 rounded-lg border border-border-strong bg-surface-raised p-4 wl-colors dark:shadow-(--wl-edge)',
          'hover:border-fg-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
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
        <span className="flex items-center gap-3">
          <span
            aria-hidden
            className={cn(
              'inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken wl-colors',
              checked ? 'text-accent-fg' : 'text-fg-muted',
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
          <span
            id={nameId}
            className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-strong"
          >
            {plan.label}
          </span>
          {isCurrent ? (
            <Badge id={currentId} tone="accent" className={popCurrent ? 'plan-pop' : undefined}>
              {PLAN_COPY.current}
            </Badge>
          ) : null}
        </span>
        <span
          id={factsId}
          className="flex flex-col gap-3 @[34rem]/plan:flex-row @[34rem]/plan:items-center @[34rem]/plan:gap-8"
        >
          <span className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <Count
              value={facts.passes}
              from={from?.passes}
              playKey={playKey}
              unit={PLAN_COPY.passesUnit(facts.passes)}
              none={PLAN_COPY.noPasses}
              noLimit={PLAN_COPY.noLimitPasses}
            />
            <Count
              value={facts.templates}
              from={from?.templates}
              playKey={playKey}
              unit={PLAN_COPY.templatesUnit(facts.templates)}
              none={PLAN_COPY.noTemplates}
              noLimit={PLAN_COPY.noLimitTemplates}
            />
          </span>
          <ChannelChips facts={facts} />
        </span>
        <span className="mt-auto flex min-h-9 items-center border-t border-border pr-10 pt-2 text-xs text-fg-muted pointer-coarse:min-h-11">
          <span className="sr-only">{PLAN_COPY.footerLead} </span>
          <FooterSample level={facts.footer} />
        </span>
      </label>
      <span className="absolute right-3 bottom-4.5 pointer-coarse:bottom-4">
        <PlanFooterInfo plan={plan.label} level={facts.footer} orgName={orgName} />
      </span>
    </div>
  );
}
