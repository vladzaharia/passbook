import { useCallback, useEffect, useRef } from 'react';
import { useKept } from '../keep.tsx';
import type { Arrival } from './types.ts';

/** The ledger read: rows after `since`, or null when nothing changed since `etag` (a 304). */
export type ArrivalLoader = (
  since: number,
  etag: string | undefined,
) => Promise<{ rows: Arrival[]; etag?: string | undefined } | null>;

export interface FeedMarks {
  /** Poll gap while the page is visible. */
  visibleMs: number;
  /** Poll gap while it is hidden. */
  hiddenMs: number;
  /** Nothing arrived by now: the troubleshooting opens. Listening goes on. */
  slowMs: number;
  /** Polling stops until Resume. Its only purpose is saving requests. */
  pauseMs: number;
}

export const MARKS: FeedMarks = {
  visibleMs: 2000,
  hiddenMs: 15_000,
  slowMs: 3 * 60_000,
  pauseMs: 15 * 60_000,
};

/**
 * Polls the arrival ledger: every 2 s while the page is visible, 15 s while hidden, at once when it
 * becomes visible again, with the ETag so an unchanged answer costs nothing. No hard timeout: at 3
 * minutes `slow` turns on, at 15 polling pauses until `resume`. An error stops the loop until `retry`.
 */
export function useArrivalFeed(load: ArrivalLoader, since: number, marks: Partial<FeedMarks> = {}) {
  const m = { ...MARKS, ...marks };
  const loadRef = useRef(load);
  loadRef.current = load;
  // The panel may be remounted by a layout change (two-sided.tsx): what it knew and when its clock
  // started are kept, so a resize neither empties it nor restarts the 3 and 15 minutes.
  const key = `feed:${since}`;
  const [rows, setRows] = useKept<Arrival[]>(`${key}:rows`, []);
  const [error, setError] = useKept<unknown>(`${key}:error`, null);
  const [slow, setSlow] = useKept(`${key}:slow`, false);
  const [paused, setPaused] = useKept(`${key}:paused`, false);
  // A run is one stretch of polling: Resume and Retry start a new one, with its own clock.
  const [clock, setClock] = useKept(`${key}:clock`, { run: 0, startedAt: 0 });
  const { run } = clock;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const stoppedAlready = useRef({ error, paused });
  stoppedAlready.current = { error, paused };
  const { visibleMs, hiddenMs, slowMs, pauseMs } = m;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` restarts the loop and its clock.
  useEffect(() => {
    // A remount after the loop stopped (an error, the pause) shows that state, and does not poll.
    if (stoppedAlready.current.error !== null || stoppedAlready.current.paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let etag: string | undefined;
    const startedAt = clockRef.current.startedAt || Date.now();
    if (clockRef.current.startedAt === 0) setClock({ run: clockRef.current.run, startedAt });
    const spent = Date.now() - startedAt;
    const slowTimer = setTimeout(() => setSlow(true), Math.max(0, slowMs - spent));
    const pauseTimer = setTimeout(
      () => {
        stopped = true;
        clearTimeout(timer);
        setPaused(true);
      },
      Math.max(0, pauseMs - spent),
    );

    async function tick() {
      clearTimeout(timer);
      if (stopped) return;
      try {
        const got = await loadRef.current(since, etag);
        if (stopped) return;
        if (got) {
          etag = got.etag;
          setRows(got.rows);
        }
        setError(null);
      } catch (cause) {
        if (stopped) return;
        stopped = true;
        setError(cause);
        return;
      }
      if (Date.now() - startedAt >= pauseMs) return;
      timer = setTimeout(
        () => void tick(),
        document.visibilityState === 'hidden' ? hiddenMs : visibleMs,
      );
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !stopped) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(slowTimer);
      clearTimeout(pauseTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [
    since,
    run,
    visibleMs,
    hiddenMs,
    slowMs,
    pauseMs,
    setClock,
    setError,
    setPaused,
    setRows,
    setSlow,
  ]);

  const restart = useCallback(() => {
    setPaused(false);
    setError(null);
    setSlow(false);
    setClock((c) => ({ run: c.run + 1, startedAt: 0 }));
  }, [setSlow, setPaused, setError, setClock]);

  return { rows, error, slow, paused, resume: restart, retry: restart };
}
