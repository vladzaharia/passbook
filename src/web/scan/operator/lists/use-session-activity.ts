import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanApi } from '../../api/scan-api.ts';
import type { ActivityItem } from './activity-model.ts';

/** Between polls while the hub is away: this is as live as the list gets. */
export const POLL_STEPS_MS = [4000, 8000, 16_000, 30_000] as const;
/** Between polls while the hub is up: a pulse reads at once, so this only catches a pulse that never came. */
export const HUB_POLL_MS = 30_000;
/** Pulses that arrive together read once. */
const PULSE_WAIT_MS = 200;

export interface ActivityPoll {
  /** Changes with each hub pulse. */
  kick: number;
  hubUp: boolean;
}
const TIMEOUT_MS = 8000;

/**
 * The session's recent scans from every device, and its problems page (refusals and holds of the
 * last 15 minutes, which the newest-20 page cannot hold at a busy door).
 *
 * One request at a time: a tick that finds one in flight waits. Only `refresh`, after this
 * device's own scan or undo, or a hub pulse, replaces a request. A failure backs the poll off
 * (4, 8, 16, 30 s); a hidden tab or no connection pauses it; coming back, or the network
 * returning, loads at once. With the hub up the poll is a 30 s safety net, not the feed.
 */
export function useSessionActivity(api: ScanApi, online: boolean, hub?: ActivityPoll) {
  const hubUp = hub?.hubUp ?? false;
  const kick = hub?.kick ?? 0;
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [problemItems, setProblemItems] = useState<ActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const step = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef({ online, hubUp });
  live.current = { online, hubUp };

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `hubUp` sets the cadence; the schedule restarts when it changes
  useEffect(() => {
    let stopped = false;
    const schedule = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(
        async () => {
          if (stopped) return;
          if (!document.hidden && live.current.online) await load(false);
          if (!stopped) schedule();
        },
        live.current.hubUp ? HUB_POLL_MS : POLL_STEPS_MS[step.current],
      );
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
  }, [load, hubUp]);

  // A pulse is a scan somewhere in the session: read again, once for a burst of them.
  useEffect(() => {
    if (kick === 0) return;
    const t = setTimeout(() => void load(true), PULSE_WAIT_MS);
    return () => clearTimeout(t);
  }, [kick, load]);

  const refresh = useCallback(() => load(true), [load]);
  return { items, problemItems, loaded, unavailable, syncedAt, refresh };
}
