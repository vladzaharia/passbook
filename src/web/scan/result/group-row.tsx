import { Check, Clock, UserRound, Users, X } from 'lucide-react';
import type { ScanReason } from '../../../shared/contracts/scan.ts';
import { SCAN_REASON_COPY } from '../../../shared/copy/scan.ts';
import { SCAN_GROUP_COPY } from '../../../shared/copy/scan-group.ts';
import { Button } from '../../ui/button.tsx';
import { type GroupPerson, type GroupView, groupAction } from '../machine/group-view.ts';
import type { ScanOutcome } from '../machine/types.ts';
import './group.css';

const initials = (name: string): string => name.slice(0, 2).toUpperCase();

function Disc({ person }: { person: GroupPerson }) {
  if (person.state === 'in') return <Check size={20} strokeWidth={3} aria-hidden />;
  if (person.state === 'already') return <Clock size={20} strokeWidth={2.5} aria-hidden />;
  if (person.state === 'refused') return <X size={20} strokeWidth={3} aria-hidden />;
  return person.name ? (
    <b aria-hidden>{initials(person.name)}</b>
  ) : (
    <UserRound size={20} aria-hidden />
  );
}

/**
 * The people behind the scanned pass, one disc each: in, still to check in, already in, not let in.
 * The server names members only once the group ran, so before that only the scanned person has a name.
 */
export function GroupRow({
  view,
  outcome,
  onGroup,
}: {
  view: GroupView;
  outcome: ScanOutcome;
  /** A heads-up card has no dock button for it: the row carries one. */
  onGroup?: (() => void) | undefined;
}) {
  // Why someone was not let in is what staff act on: the first two, by name.
  const why = view.people
    .filter((p) => p.state === 'refused')
    .slice(0, 2)
    .map((p) => {
      const reason = p.reason
        ? SCAN_REASON_COPY[p.reason as ScanReason]?.headline.replace(/\s*\{.*$/, '')
        : null;
      return [p.name, reason ?? SCAN_GROUP_COPY.state.refused].filter(Boolean).join(': ');
    });
  const more = onGroup && outcome.kind !== 'ok' ? groupAction({ ...outcome, kind: 'ok' }) : null;
  return (
    <div className="scan-group-people" data-testid="scan-group-row">
      <ul aria-label={SCAN_GROUP_COPY.label}>
        {view.people.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: members have no id on the wire
          <li key={i} data-state={p.state}>
            <span className="scan-group-disc">
              <Disc person={p} />
            </span>
            <span className="scan-group-name" aria-hidden>
              {p.name}
            </span>
            <span className="sr-only">
              {p.name ? `${p.name}, ` : ''}
              {SCAN_GROUP_COPY.person[p.state]}
            </span>
          </li>
        ))}
      </ul>
      {why.length ? (
        <p className="scan-group-why" data-testid="scan-group-why">
          {why.join(' · ')}
        </p>
      ) : null}
      {more && onGroup ? (
        <Button
          variant="outline"
          iconStart={<Users aria-hidden />}
          data-testid="scan-group-more"
          onClick={onGroup}
        >
          {more.label}
        </Button>
      ) : null}
    </div>
  );
}
