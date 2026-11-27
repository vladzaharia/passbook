import { useEffect, useRef } from 'react';
import { backoffMs } from '../../lib/poll-backoff.ts';
import { holdPoll } from '../../lib/poll-hold.ts';

/** One read every 2 s at most for the whole page: 30 a minute, whatever is listening. */
export const QS_TICK_MS = 2000;
const KEY = 'quickstart';

interface Entry {
  run: () => unknown;
  last: number;
}

const entries = new Map<string, Entry>();
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let resumeAt = 0;
let streak = 0;

/** Runs the poll that has waited longest. A 429 holds the whole page back, by `Retry-After` or doubling to 60 s. */
async function tick(): Promise<void> {
  if (busy || document.visibilityState !== 'visible' || Date.now() < resumeAt) return;
  let next: Entry | undefined;
  for (const e of entries.values()) if (!next || e.last < next.last) next = e;
  if (!next) return;
  next.last = Date.now();
  busy = true;
  try {
    await next.run();
    streak = 0;
    resumeAt = 0;
    holdPoll(KEY, null);
  } catch (error) {
    const wait = backoffMs(QS_TICK_MS, error, streak + 1);
    if (wait === null) {
      streak = 0;
      holdPoll(KEY, null);
    } else {
      streak += 1;
      resumeAt = Date.now() + wait;
      holdPoll(KEY, resumeAt);
    }
  } finally {
    busy = false;
  }
}

/**
 * Registers a poll while `active`. All the page's polls (the listener, the sandbox's captures, the home read, the
 * caught-event read) share one loop, so the page makes one call at a time. `run` throws to report a failure: a 429
 * slows the loop, anything else is a missed poll.
 */
export function useSinglePoll(id: string, active: boolean, run: () => unknown): void {
  const fn = useRef(run);
  fn.current = run;
  useEffect(() => {
    if (!active) return;
    entries.set(id, { run: () => fn.current(), last: 0 });
    timer ??= setInterval(() => void tick(), QS_TICK_MS);
    return () => {
      entries.delete(id);
      if (entries.size > 0) return;
      clearInterval(timer);
      timer = undefined;
      busy = false;
      streak = 0;
      resumeAt = 0;
      holdPoll(KEY, null);
    };
  }, [id, active]);
}
