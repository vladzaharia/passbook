import { backoffMs, reportPolls } from './poll-backoff.ts';

/** Which pollers wait out a 429 right now, for the Paused for a moment mark. */
const held = new Map<string, number>();
const subs = new Set<() => void>();

/** Marks the poller `key` paused until `until` (ms), or running again when null. */
export function holdPoll(key: string, until: number | null): void {
  if (until === null ? !held.delete(key) : held.get(key) === until) return;
  if (until !== null) held.set(key, until);
  for (const fn of subs) fn();
}

export const pollPaused = (): boolean => [...held.values()].some((t) => t > Date.now());

export function subscribePoll(fn: () => void): () => void {
  subs.add(fn);
  return () => void subs.delete(fn);
}

/** The pace of a hand-rolled poll loop: `after(error)` is how long to wait before the next read. */
export function pacer(key: string, ms: number) {
  let streak = 0;
  return {
    after(error?: unknown): number {
      const wait = backoffMs(ms, error, streak + 1);
      if (wait === null) {
        streak = 0;
        holdPoll(key, null);
        return ms;
      }
      streak += 1;
      holdPoll(key, Date.now() + wait);
      return wait;
    },
    stop: () => holdPoll(key, null),
  };
}

reportPolls(holdPoll);
