import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [rows, setRows] = useState<Arrival[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [slow, setSlow] = useState(false);
  const [paused, setPaused] = useState(false);
  // A run is one stretch of polling: Resume and Retry start a new one, with its own clock.
  const [run, setRun] = useState(0);
  const { visibleMs, hiddenMs, slowMs, pauseMs } = m;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` restarts the loop and its clock.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let etag: string | undefined;
    const startedAt = Date.now();
    const slowTimer = setTimeout(() => setSlow(true), slowMs);
    const pauseTimer = setTimeout(() => {
      stopped = true;
      clearTimeout(timer);
      setPaused(true);
    }, pauseMs);

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
  }, [since, run, visibleMs, hiddenMs, slowMs, pauseMs]);

  const restart = useCallback(() => {
    setPaused(false);
    setError(null);
    setSlow(false);
    setRun((n) => n + 1);
  }, []);

  return { rows, error, slow, paused, resume: restart, retry: restart };
}
