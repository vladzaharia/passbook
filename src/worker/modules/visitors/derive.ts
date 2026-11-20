import type { VisitorStatus } from '../../../shared/contracts/visitors.ts';

export interface VisitFacts {
  now: number;
  windowFrom: number;
  windowUntil: number;
  cancelled: boolean;
  /** First counted check-in scan, or null. */
  arrivedAt: number | null;
  /** The latest check-in scan that was not undone. */
  lastInAt: number | null;
  /** The latest exit scan, or the departure the desk or console recorded. */
  lastOutAt: number | null;
}

export interface VisitState {
  status: VisitorStatus;
  at: number | null;
  autoOut: boolean;
}

/**
 * A visit's status, from the scans and the window. Nothing is stored for it: a visitor still in
 * when the window ends reads as out at the window's end (read-time auto check-out), and one never
 * checked in reads as expected, then as a no-show once the window is over.
 */
export function deriveVisit(f: VisitFacts): VisitState {
  if (f.cancelled) return { status: 'cancelled', at: null, autoOut: false };
  if (f.arrivedAt === null)
    return f.now > f.windowUntil
      ? { status: 'no_show', at: null, autoOut: false }
      : { status: 'expected', at: null, autoOut: false };
  const lastIn = f.lastInAt ?? f.arrivedAt;
  if (f.lastOutAt !== null && f.lastOutAt >= lastIn)
    return { status: 'out', at: f.lastOutAt, autoOut: false };
  if (f.now > f.windowUntil)
    return { status: 'out', at: Math.max(f.windowUntil, lastIn), autoOut: true };
  return { status: 'in', at: f.arrivedAt, autoOut: false };
}

export const stayOf = (arrivedAt: number | null, leftAt: number): number | null =>
  arrivedAt === null || leftAt < arrivedAt ? null : leftAt - arrivedAt;
