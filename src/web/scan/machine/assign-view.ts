/** What the views read off the machine for tags. Pure. */
import type { AssignState, AssignStrip, PendingRequest } from './assign-state.ts';
import type { MachineState } from './internal.ts';
import type { ScanState } from './types.ts';

export const assignOf = (s: ScanState): AssignState | null => (s as MachineState).assign ?? null;
export const stripOfAssign = (s: ScanState): AssignStrip | null =>
  (s as MachineState).assignStrip ?? null;
export const requestOf = (s: ScanState): PendingRequest | null =>
  (s as MachineState).tagRequest ?? null;

/** The mm:ss of a request, rounded up. */
export function countdown(expiresAt: number, now: number): string {
  const total = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
