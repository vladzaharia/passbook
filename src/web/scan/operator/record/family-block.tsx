import { Users } from 'lucide-react';
import { SCAN_REASON_COPY, scanLine } from '../../../../shared/copy/scan.ts';
import { SCAN_GROUP_COPY } from '../../../../shared/copy/scan-group.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import { GroupChip } from '../../result/group-chip.tsx';
import { PersonAvatar } from '../lists/person-avatar.tsx';
import { type BundleMember, membersOf } from './record-model.ts';

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

/** Each member by initials, with In or Out, and why a refused one was not let in. */
function Members({ members }: { members: BundleMember[] }) {
  return (
    <ul className="op-family-members">
      {members.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: members have no id on the wire
        <li key={i} data-in={m.checkedIn || undefined}>
          <PersonAvatar name={m.initials} initials={m.initials || '–'} />
          <span className="op-family-state">
            {m.checkedIn
              ? SCAN_GROUP_COPY.state.done
              : m.refusedReason
                ? (SCAN_REASON_COPY[m.refusedReason as keyof typeof SCAN_REASON_COPY]?.headline ??
                  SCAN_GROUP_COPY.state.refused)
                : R.out}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The bundle behind this pass; after a group check-in, each member's verdict (the scanner's own list). */
export function FamilyBlock({ outcome }: { outcome: ScanOutcome }) {
  const bundle = outcome.bundle ?? outcome.card?.bundle ?? null;
  if (!bundle && !outcome.group) return null;
  const members = membersOf(bundle);
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
      {members ? <Members members={members} /> : bundle ? <Dots bundle={bundle} /> : null}
      {outcome.group ? <GroupChip outcome={outcome} /> : null}
    </section>
  );
}
