import { type CSSProperties, useRef, useState } from 'react';
import type { PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import { type PlanFacts, planFacts } from '@/shared/plan-facts.ts';
import { PlanTile } from './plan-tile.tsx';

/**
 * The last card takes the empty cells of its row, so a short last row is one wide card: two columns from
 * 36rem, three from 54rem (container widths, set on the picker).
 */
export function lastSpan(count: number): string {
  const two = count % 2 === 1 ? '@[36rem]:col-span-2' : '';
  const rest = count % 3;
  const three =
    rest === 2
      ? '@[54rem]:col-span-2'
      : rest === 1
        ? '@[54rem]:col-span-3'
        : count % 2 === 1
          ? '@[54rem]:col-span-1'
          : '';
  return `${two} ${three}`.trim();
}

/**
 * The plan cards, one radio group. `current` is the org's plan (null before it has one); `picked` the
 * choice. The same picker serves the Features tab and its empty state.
 */
export function PlanPicker({
  plans,
  current,
  picked,
  onPick,
  arrival,
  orgName,
}: {
  plans: readonly PresetOptionDto[];
  current: string | null;
  picked: string | null;
  onPick: (preset: string) => void;
  /** How the cards enter (see useArrivalMode); false once they are in. */
  arrival?: false | 'rise' | 'quiet';
  /** The org the plans are for, where it is known. */
  orgName?: string;
}) {
  const facts = new Map<string, PlanFacts>(plans.map((p) => [p.preset, planFacts(p.values)]));
  const from = current ? facts.get(current) : undefined;
  const [plays, setPlays] = useState<Record<string, number>>({});
  const first = useRef(current);
  const span = lastSpan(plans.length);
  return (
    <div className="@container">
      <fieldset>
        <legend className="sr-only">{PLAN_COPY.title}</legend>
        <div
          className={`grid grid-cols-1 gap-3 @[36rem]:grid-cols-2 @[54rem]:grid-cols-3 ${arrival ? 'wl-stagger' : ''}`}
          data-quiet={arrival === 'quiet' || undefined}
        >
          {plans.map((p, i) => (
            <PlanTile
              key={p.preset}
              plan={p}
              facts={facts.get(p.preset) as PlanFacts}
              from={from}
              isCurrent={p.preset === current}
              popCurrent={current !== first.current}
              checked={picked === p.preset}
              playKey={plays[p.preset] ?? 0}
              orgName={orgName}
              className={i === plans.length - 1 ? `${span} self-start`.trim() : undefined}
              style={{ '--i': i } as CSSProperties}
              onSelect={(id) => {
                setPlays((s) => ({ ...s, [id]: (s[id] ?? 0) + 1 }));
                onPick(id);
              }}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}
