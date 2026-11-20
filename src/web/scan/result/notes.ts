import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import { accessLines } from '../machine/access-view.ts';
import type { ScanOutcome } from '../machine/types.ts';

/**
 * A refusal or a hold (gym full, already in) changed nothing: no stamp, balance or staff note for
 * a grant, so the card cannot read as granted.
 */
export function isDenied(o: ScanOutcome, now: number): boolean {
  return (
    o.kind === 'refused' ||
    (o.kind === 'heads_up' && (Boolean(accessLines(o, now)) || Boolean(o.occupancy)))
  );
}

/** The notes a verdict carries for staff: the template's, then the event's on a stop or a hold. */
export function outcomeNotes(
  o: ScanOutcome,
  d: ScanDisplay | null,
  eventNote: string | null | undefined,
  denied: boolean,
): string[] {
  return [
    ...new Set(
      [
        o.kind === 'refused' ? d?.notes.refused : denied ? null : d?.notes.staff,
        o.kind === 'refused' || o.kind === 'heads_up' ? eventNote : null,
      ].filter((note): note is string => Boolean(note)),
    ),
  ];
}
