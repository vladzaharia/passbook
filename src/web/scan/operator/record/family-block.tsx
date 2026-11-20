import { Users } from 'lucide-react';
import { scanLine } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import { GroupChip } from '../../result/group-chip.tsx';

const R = OPERATOR_COPY.record;

/** One dot per pass on the bundle, filled for each one that is in. The wire carries counts, not names. */
function Dots({ bundle }: { bundle: NonNullable<ScanOutcome['bundle']> }) {
  const size = Math.min(bundle.size, 12);
  const done = Math.min(bundle.checkedIn ?? 0, size);
  return (
    <span className="op-family-dots" aria-hidden>
      {Array.from({ length: size }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of dots
        <i key={i} data-in={i < done || undefined} />
      ))}
    </span>
  );
}

/** The bundle behind this pass; after a group check-in, each member's verdict (the scanner's own list). */
export function FamilyBlock({ outcome }: { outcome: ScanOutcome }) {
  const bundle = outcome.bundle ?? outcome.card?.bundle ?? null;
  if (!bundle && !outcome.group) return null;
  return (
    <section className="op-block" aria-label={R.familyHead} data-testid="op-family">
      <div className="op-block-h">
        <h3>
          <Users aria-hidden /> {bundle?.name || R.familyHead}
        </h3>
        {bundle ? (
          <span className="op-block-aside">
            {scanLine(R.familyCount, { n: bundle.checkedIn ?? 0, total: bundle.size })}
          </span>
        ) : null}
      </div>
      {bundle ? <Dots bundle={bundle} /> : null}
      {outcome.group ? <GroupChip outcome={outcome} /> : null}
    </section>
  );
}
