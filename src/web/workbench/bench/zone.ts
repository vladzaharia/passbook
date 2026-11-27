import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { loadSession, onSession, type Session } from '../console/session.ts';

/**
 * The zone every Workbench time reads in: the sandbox org's (`sandbox.timeZone`, WB0), else the
 * default. Never UTC, never the browser's. One store for the page, filled from the session.
 */
let zone: string = DEFAULT_TIME_ZONE;
const listeners = new Set<() => void>();
let following = false;

export function setBenchZone(next: string | null | undefined): void {
  const value = next || DEFAULT_TIME_ZONE;
  if (value === zone) return;
  zone = value;
  for (const fn of listeners) fn();
}

export const benchZone = (): string => zone;

const fromSession = (s: Session) => {
  if (s.kind === 'ready') setBenchZone(s.sandbox.timeZone);
};

/** Reads the session once and follows it; safe to call from every island. */
export function followSessionZone(): void {
  if (following) return;
  following = true;
  void loadSession().then(fromSession);
  onSession(fromSession);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The org's zone; redraws when the session names another. */
export function useBenchZone(): string {
  useEffect(followSessionZone, []);
  return useSyncExternalStore(subscribe, benchZone, () => DEFAULT_TIME_ZONE);
}

/** For tests: back to the default, not following. */
export function resetBenchZone(): void {
  zone = DEFAULT_TIME_ZONE;
  following = false;
}
