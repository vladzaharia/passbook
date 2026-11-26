import { Clock, LogOut } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { EntityAvatar } from '../../ui/avatar.tsx';
import { Button } from '../../ui/button.tsx';
import { stayText } from '../machine/access-view.ts';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import { sessionTime } from '../ui/session-time.ts';
import { flagged } from './inside-model.ts';
import type { InsideRow } from './inside-types.ts';

const FLAG_TEXT = {
  long_stay: ACCESS_COPY.inside.longStay,
  pass_ended: ACCESS_COPY.inside.passEnded,
};

/** `Floor 3, HQ · In since 7:58 AM · 4 h 12 min`. */
export function metaOf(row: InsideRow, now: number): string {
  return [
    [row.zone.name, row.zone.parent].filter(Boolean).join(', '),
    `In since ${sessionTime(row.since)}`,
    stayText(Math.max(0, now - row.since)),
  ].join(' · ');
}

/**
 * One person inside. The row opens their card; `trailing` is the row's action: Mark as out here,
 * the Safe toggle in roll call.
 */
export function InsideRowView({
  row,
  now,
  onOpen,
  trailing,
  index = 0,
}: {
  row: InsideRow;
  now: number;
  onOpen: (row: InsideRow) => void;
  trailing: ReactNode;
  /** The row's place in the list: the entrance stagger. */
  index?: number;
}) {
  const name = row.holder ?? ACCESS_COPY.inside.unnamed;
  return (
    <li
      className="scan-in-row"
      data-row-id={row.passId}
      data-flag={flagged(row) ? 'amber' : undefined}
      data-testid="inside-row"
      style={{ '--i': index } as CSSProperties}
    >
      <button type="button" className="scan-in-open" onClick={() => onOpen(row)}>
        {row.photoUrl ? (
          <img className="scan-in-photo" src={row.photoUrl} alt="" width={40} height={40} />
        ) : (
          <EntityAvatar kind="user" id={row.passId} name={name} size={40} />
        )}
        <span className="scan-in-main">
          <span className="scan-in-name">
            <span className="scan-in-who" dir="auto">
              {name}
            </span>
            {row.type ? <span className="scan-in-plan">{row.type}</span> : null}
            {row.flags.map((flag) => (
              <span key={flag} className="scan-in-flag">
                {FLAG_TEXT[flag]}
              </span>
            ))}
          </span>
          {row.host ? (
            <span className="scan-in-meta">
              {fill(ACCESS_COPY.inside.host, { name: row.host })}
            </span>
          ) : null}
          <span className="scan-in-meta">{metaOf(row, now)}</span>
          {row.dueAt ? (
            <span className="scan-in-meta scan-in-due">
              <Clock aria-hidden size={12} />
              {fill(ACCESS_COPY.inside.outBy, { time: sessionTime(row.dueAt) })}
            </span>
          ) : null}
        </span>
      </button>
      <div className="scan-in-trailing">{trailing}</div>
    </li>
  );
}

export function MarkOutButton({
  row,
  disabled,
  onMark,
}: {
  row: InsideRow;
  disabled: boolean;
  onMark: (row: InsideRow) => void;
}) {
  const name = row.holder ?? ACCESS_COPY.inside.unnamed;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="scan-in-mark"
      disabled={disabled}
      title={disabled ? ACCESS_COPY.inside.needsConnection : undefined}
      aria-label={`${SCAN_COPY.actions.markAsOut}: ${name}`}
      iconStart={<LogOut aria-hidden />}
      onClick={() => onMark(row)}
    >
      {SCAN_COPY.actions.markAsOut}
    </Button>
  );
}
