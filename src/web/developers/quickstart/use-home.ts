import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { fetchHome } from '../workbench/api.ts';

/**
 * The quickstart's progress, read from `GET /developer/home`: a reload shows the same page, and the steps tick only
 * when the database says so. `skew` is server time minus device time at the last read, so clocks count from the
 * server's start.
 */
export function useHome() {
  const [home, setHome] = useState<DeveloperHome | null>(null);
  const [skew, setSkew] = useState(0);
  const live = useRef(true);
  const refresh = useCallback(async (): Promise<DeveloperHome | null> => {
    try {
      const next = await fetchHome();
      if (!live.current) return null;
      setSkew(next.now - Date.now());
      setHome(next);
      return next;
    } catch {
      // The page keeps what it has; the next read or poll tries again.
      return null;
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);
  return { home, skew, refresh };
}

/** Runs `tick` every `ms` while `active` and the tab is in view. */
export function usePoll(active: boolean, tick: () => void, ms: number): void {
  const fn = useRef(tick);
  fn.current = tick;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') fn.current();
    }, ms);
    return () => clearInterval(t);
  }, [active, ms]);
}
