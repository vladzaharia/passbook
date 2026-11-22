import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { duration } from '../workbench/model.ts';

/**
 * The quickstart's clock as every page shows it: when the track started, when it finished, and how far the device
 * clock is from the server's. It comes from `GET /developer/home`, so a reload or another page keeps it.
 */
export interface RunClock {
  startedAt: number;
  doneAt: number | null;
  /** Server time minus device time at the read. */
  skew: number;
}

let current: RunClock | null = null;
let pending: Promise<void> | undefined;
const listeners = new Set<(c: RunClock | null) => void>();

/** The page that read the home says so, so the header chip follows without a second read. */
export function publishClock(home: DeveloperHome | null): void {
  pending = Promise.resolve();
  current =
    home?.state === 'open' && home.progress
      ? {
          startedAt: home.progress.startedAt,
          doneAt: home.progress.doneAt,
          skew: home.now - Date.now(),
        }
      : null;
  for (const fn of listeners) fn(current);
}

/** One read per page for whoever has no home yet: the chip on a page that is not the quickstart. */
export function loadClock(read: () => Promise<DeveloperHome>): Promise<void> {
  pending ??= read().then(publishClock, () => {
    // No clock is a chip without one; the page itself still works.
  });
  return pending;
}

export function onClock(fn: (c: RunClock | null) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

/** `1:02`: the run time so far, or null once the track is done. */
export function runTime(c: RunClock, device = Date.now()): string | null {
  return c.doneAt === null ? duration(device + c.skew - c.startedAt) : null;
}
