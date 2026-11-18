/** The place a scanner counts: its zone, else an event that tracks exits. Null when it counts none. */
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { Counts } from '../machine/types.ts';

export interface TrackedPlace {
  name: string;
  inNow: number;
  capacity: number | null;
}

export function trackedPlace(
  counts: Counts,
  event: ScanSession['event'] | undefined,
): TrackedPlace | null {
  if (counts.place) return counts.place;
  const e = counts.event;
  if (e && e.inside !== null && event?.reentry)
    return { name: event.name, inNow: e.inside, capacity: e.capacity };
  return null;
}

/** Desk and Manager staff, or a scanner that runs as a desk with nobody signed in. */
export function isDeskRole(session: ScanSession): boolean {
  const role = session.staff?.role ?? session.scanner?.settings.roleWithoutSignIn ?? 'door';
  return role !== 'door' && session.scanner?.deviceRole === 'scan';
}
