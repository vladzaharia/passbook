import { Users } from 'lucide-react';
import type { ScanReason } from '../../../shared/contracts/scan.ts';
import { SCAN_REASON_COPY } from '../../../shared/copy/scan.ts';
import { groupLine, SCAN_GROUP_COPY } from '../../../shared/copy/scan-group.ts';
import { Button } from '../../ui/button.tsx';
import type { ScanOutcome } from '../machine/types.ts';
import './group.css';

/** The bundle behind the scanned pass: "Check in all N", then each member's verdict. */
export function GroupChip({
  outcome: o,
  onGroup,
}: {
  outcome: ScanOutcome;
  onGroup?: (() => void) | undefined;
}) {
  const g = o.group;
  if (g) {
    return (
      <section className="scan-group" data-testid="scan-group" aria-label="Bundle check-in">
        <p className="scan-group-line" data-partial={g.refused > 0 || undefined}>
          <Users size={16} aria-hidden /> {groupLine(g)}
        </p>
        <ul>
          {(g.members ?? []).map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: members have no id on the wire
            <li key={i} data-state={m.state}>
              <span>{m.name || 'Pass'}</span>
              <span>
                {m.state === 'refused' && m.reason
                  ? (SCAN_REASON_COPY[m.reason as ScanReason]?.headline ??
                    SCAN_GROUP_COPY.state.refused)
                  : SCAN_GROUP_COPY.state[m.state]}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  const b = o.bundle;
  if (!b || !onGroup || (b.checkedIn ?? 0) >= b.size) return null;
  return (
    <div className="scan-group" data-testid="scan-group-chip">
      <Button variant="outline" iconStart={<Users aria-hidden />} onClick={onGroup}>
        {SCAN_GROUP_COPY.checkInAll.replace('{total}', String(b.size))}
      </Button>
      {b.checkedIn ? (
        <p className="scan-group-count">
          {SCAN_GROUP_COPY.inCount
            .replace('{n}', String(b.checkedIn))
            .replace('{total}', String(b.size))}
        </p>
      ) : null}
    </div>
  );
}
