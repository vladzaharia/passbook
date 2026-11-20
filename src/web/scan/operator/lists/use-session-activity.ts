import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanApi } from '../../api/scan-api.ts';
import type { ActivityItem } from './activity-model.ts';

/** Seconds between polls: a device gets no rows from the hub, so this is as live as the list gets. */
export const POLL_STEPS_MS = [4000, 8000, 16_000, 30_000] as const;
const TIMEOUT_MS = 8000;

/**
 * The session's recent scans from every device, and its problems page (refusals and holds of the
 * last 15 minutes, which the newest-20 page cannot hold at a busy door).
 *
 * One request at a time: a tick that finds one in flight waits. Only `refresh`, after this
 * device's own scan or undo, replaces a request. A failure backs the poll off (4, 8, 16, 30 s);
 * a hidden tab or no connection pauses it; coming back, or the network returning, loads at once.
 */
export function useSessionActivity(api: ScanApi, online: boolean) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [problemItems, setProblemItems] = useState<ActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const step = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef({ online });
  live.current = { online };

  const load = useCallback(
    async (replace: boolean) => {
      if (inflight.current) {
        if (!replace) return;
        inflight.current.abort();
      }
      const own = new AbortController();
      inflight.current = own;
      const timeout = setTimeout(() => own.abort(), TIMEOUT_MS);
      try {
        const [page, problems] = await Promise.all([
          api.activity({ signal: own.signal }),
          api.activity({ signal: own.signal, problems: true }),
        ]);
        if (own.signal.aborted) return;
        setItems(page.items);
        setProblemItems(problems.items);
        setLoaded(true);
        setUnavailable(false);
        setSyncedAt(Date.now());
        step.current = 0;
      } catch {
        // An abort that was a timeout is a failure; one that replaced this request is not.
        if (inflight.current === own) {
          setUnavailable(true);
          step.current = Math.min(step.current + 1, POLL_STEPS_MS.length - 1);
        }
      } finally {
        clearTimeout(timeout);
        if (inflight.current === own) inflight.current = null;
      }
    },
    [api],
  );

  useEffect(() => {
    let stopped = false;
    const schedule = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        if (stopped) return;
        if (!document.hidden && live.current.online) await load(false);
        if (!stopped) schedule();
      }, POLL_STEPS_MS[step.current]);
    };
    const now = () => {
      if (document.hidden || !live.current.online) return;
      step.current = 0;
      void load(false).then(schedule);
    };
    void load(true).then(schedule);
    document.addEventListener('visibilitychange', now);
    window.addEventListener('focus', now);
    window.addEventListener('online', now);
    return () => {
      stopped = true;
      clearTimeout(timer.current);
      inflight.current?.abort();
      inflight.current = null;
      document.removeEventListener('visibilitychange', now);
      window.removeEventListener('focus', now);
      window.removeEventListener('online', now);
    };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  return { items, problemItems, loaded, unavailable, syncedAt, refresh };
}
