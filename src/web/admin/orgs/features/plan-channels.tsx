import { CHANNEL_CHIP, PLAN_COPY } from '@/shared/copy/plans.ts';
import type { PlanFacts } from '@/shared/plan-facts.ts';
import { Badge } from '@/web/ui/index.ts';

function Chip({ on, children }: { on: boolean; children: string }) {
  return on ? (
    <Badge>{children}</Badge>
  ) : (
    <span className="inline-flex min-h-6 items-center rounded-full border border-dashed border-border-strong px-2 text-xs whitespace-nowrap text-fg-subtle">
      {children}
      <span className="sr-only"> {PLAN_COPY.notIncluded}</span>
    </span>
  );
}

/**
 * The five channels in fixed slots. A plan card shows the missing ones dashed, so plans compare at a
 * glance; `onlyIncluded` is the organization's own view, which lists what it has.
 */
export function ChannelChips({
  facts,
  onlyIncluded = false,
}: {
  facts: PlanFacts;
  onlyIncluded?: boolean;
}) {
  const chips: [string, string, boolean][] = [
    ['apple', CHANNEL_CHIP.apple, true],
    ['google', CHANNEL_CHIP.google, facts.google],
    ['samsung', CHANNEL_CHIP.samsung, facts.samsung],
    ['print', CHANNEL_CHIP.print, facts.print],
    ['nfc', CHANNEL_CHIP.nfc[facts.nfc], facts.nfc !== 'off'],
  ];
  return (
    <ul aria-label={PLAN_COPY.channels} className="flex flex-wrap gap-1.5">
      {chips
        .filter(([, , on]) => on || !onlyIncluded)
        .map(([id, label, on]) => (
          <li key={id}>
            <Chip on={on}>{label}</Chip>
          </li>
        ))}
    </ul>
  );
}
