import { type CSSProperties, useRef, useState } from 'react';
import type { PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import { PlanTile } from './plan-tile.tsx';

/** More plans than this stay a scrolling row at any width. */
const ROW_MAX = 5;

/**
 * The plan tiles, one radio group: one row of equal tiles where there is room, a snapping row you scroll
 * sideways below that, one column on a phone. `current` is the org's plan (null before it has one);
 * `picked` the choice. The same picker serves the Features tab and its empty state.
 */
export function PlanPicker({
  plans,
  current,
  picked,
  onPick,
  arrival,
}: {
  plans: readonly PresetOptionDto[];
  current: string | null;
  picked: string | null;
  onPick: (preset: string) => void;
  /** How the tiles enter (see useArrivalMode); false once they are in. */
  arrival?: false | 'rise' | 'quiet';
}) {
  const [plays, setPlays] = useState<Record<string, number>>({});
  const first = useRef(current);
  return (
    <div className="plan-picker @container">
      <div
        role="radiogroup"
        aria-label={PLAN_COPY.title}
        className={`plan-row ${arrival ? 'wl-stagger' : ''}`}
        data-many={plans.length > ROW_MAX || undefined}
        data-quiet={arrival === 'quiet' || undefined}
        style={{ '--plans': plans.length } as CSSProperties}
      >
        {plans.map((p, i) => (
          <PlanTile
            key={p.preset}
            plan={p}
            isCurrent={p.preset === current}
            popCurrent={current !== first.current}
            checked={picked === p.preset}
            playKey={plays[p.preset] ?? 0}
            style={{ '--i': i } as CSSProperties}
            onSelect={(id) => {
              setPlays((s) => ({ ...s, [id]: (s[id] ?? 0) + 1 }));
              onPick(id);
            }}
          />
        ))}
      </div>
    </div>
  );
}
