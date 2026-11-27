import type { WalletEnrolment } from '@/shared/contracts/wallet-providers.ts';
import { checkFresh } from './check.ts';
import { BLOCKER } from './copy.ts';

export interface Gate {
  label: string;
  ok: boolean;
  /** The plain state: "Passed", "Needed", "Done". */
  state: string;
}

/** What the switch waits on, shown as plain rows; null roundTrip (Test) has no such row. */
export function gatesOf(e: WalletEnrolment): Gate[] {
  const fresh = checkFresh(null, 0, e.prerequisites.check);
  const gates: Gate[] = [
    { label: 'Enrolment check', ok: fresh, state: fresh ? 'Passed' : 'Needed' },
  ];
  if (e.prerequisites.roundTrip !== null)
    gates.push({
      label: 'Test round trip',
      ok: e.prerequisites.roundTrip,
      state: e.prerequisites.roundTrip ? 'Done' : 'Needed',
    });
  return gates;
}

/** Why the switch cannot turn on, or null. The first thing to fix comes first. */
export function blockerOf(e: WalletEnrolment): string | null {
  if (e.state === 'held') return BLOCKER.held(e.hold?.reason ?? '');
  if (e.state === 'revoked') return BLOCKER.revoked;
  if (e.source === null) return BLOCKER.source;
  if (!checkFresh(null, 0, e.prerequisites.check)) return BLOCKER.check;
  if (e.prerequisites.roundTrip === false) return BLOCKER.roundTrip;
  return null;
}
