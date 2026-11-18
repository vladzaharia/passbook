import type { ScanStaffRow } from './repo-staff.ts';
import type { PinStaffSnapshot } from './staff-pin-snapshot.ts';

/** Whether `stored` is the PIN's hash: under the root now, or (mid-rotation) under the previous one. */
export type PinMatches = (
  env: object,
  staffId: string,
  pin: string,
  stored: string,
) => Promise<boolean>;

export const DUMMY_PIN_HASH = '0'.repeat(64);

/** What the reservation is counted against, and the key the PINs are hashed under. */
interface Subject {
  pinEnv: object;
  orgId: string;
  staffId: string;
}

type Candidate = Pick<ScanStaffRow, 'orgId' | 'pinHash' | 'disabledAt'> &
  Partial<Pick<ScanStaffRow, 'id' | 'role'>>;

/** One person: the PIN is theirs, and they are usable (and a manager when only a manager will do). */
export const personDecision =
  (
    { pinEnv, orgId, staffId }: Subject,
    staff: Candidate | null,
    pin: string,
    managerOnly: boolean,
    matches: PinMatches,
    deskOk = false,
  ) =>
  async (): Promise<'match' | 'miss'> => {
    const usable =
      staff?.orgId === orgId &&
      staff.disabledAt === null &&
      (!managerOnly ||
        (staff.id === staffId && (staff.role === 'manager' || (deskOk && staff.role === 'desk'))));
    const matched = await matches(pinEnv, staffId, pin, usable ? staff.pinHash : DUMMY_PIN_HASH);
    return usable && matched ? 'match' : 'miss';
  };

/**
 * No one is named: the PIN is matched against every manager (all are hashed, so the time does not
 * say which matched). Exactly one match verifies; two are `ambiguous`, which counts as a miss.
 */
export function anyManagerDecision(
  { pinEnv, orgId, staffId }: Subject,
  managers: readonly PinStaffSnapshot[],
  pin: string,
  matches: PinMatches,
  anyRole = false,
  deskOk = false,
) {
  let found: PinStaffSnapshot | null = null;
  let count = 0;
  const matched: PinStaffSnapshot[] = [];
  return {
    async decide(): Promise<'match' | 'miss' | 'ambiguous'> {
      for (const manager of managers) {
        const usable =
          manager.orgId === orgId &&
          manager.disabledAt === null &&
          (anyRole || manager.role === 'manager' || (deskOk && manager.role === 'desk'));
        if (usable && (await matches(pinEnv, manager.id, pin, manager.pinHash)))
          matched.push(manager);
      }
      await matches(pinEnv, staffId, pin, DUMMY_PIN_HASH);
      // A code shared by a Manager and a Desk member is the Manager's.
      const managersOnly = matched.filter((m) => m.role === 'manager');
      const pool = managersOnly.length > 0 ? managersOnly : matched;
      count = pool.length;
      found = pool.length === 1 ? (pool[0] ?? null) : null;
      return count === 1 ? 'match' : count > 1 ? 'ambiguous' : 'miss';
    },
    found: () => found,
  };
}
