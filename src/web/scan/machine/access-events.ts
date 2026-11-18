/**
 * What WP-J adds to the machine without touching the frozen `types.ts`: two events, a draft field,
 * a resolved outcome, and the three access beats. `types.ts` takes them in the next contract PR;
 * until then the casts below are the only place that knows.
 */
import type { BuddyBeat, Draft, ScanEvent, ScanOutcome } from './types.ts';

export type AccessBeat = 'gate' | 'bye' | 'relent';

/** `BuddyBeat` has no access beats yet. The view passes the name through to the buddy as a string. */
export const accessBeat = (beat: AccessBeat): BuddyBeat => beat as unknown as BuddyBeat;

export type AccessEvent =
  /** The dock's Tap in, Tap out: an explicit direction on a held scan, past the turnaround guard. */
  | { type: 'turn'; direction: 'in' | 'out' }
  /** The hub's `resolved` for a scan this device was refused: a desk let the person in. */
  | {
      type: 'resolved';
      of: string;
      outcome: ScanOutcome;
      by: { staff: string | null; device: string | null };
    };

export type MachineEvent = ScanEvent | AccessEvent;

export type DirectionDraft = Draft & { direction?: 'in' | 'out' };

/** An outcome a desk turned: who let them in. */
export type ResolvedOutcome = ScanOutcome & { resolvedBy?: string };

export const isAccessEvent = (event: MachineEvent): event is AccessEvent =>
  event.type === 'turn' || event.type === 'resolved';
