import type { EventKind } from '../../../shared/contracts/events.ts';

/** An ok scan's ledger event: a check-in, a redeem (take, use up) or an adjustment (add, set). */
export function okEventKind(actionKind: string | null | undefined): EventKind {
  if (actionKind === 'take' || actionKind === 'use_up') return 'scan.redeemed';
  return actionKind === 'add' || actionKind === 'set' ? 'scan.adjusted' : 'scan.checked_in';
}
