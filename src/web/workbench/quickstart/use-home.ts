import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { fetchHome } from '../home/api.ts';

/**
 * The quickstart's progress, read from `GET /developer/home`: a reload shows the same page, and the steps tick only
 * when the database says so. `skew` is server time minus device time at the last read, so clocks count from the
 * server's start.
 */
export function useHome() {
  const [home, setHome] = useState<DeveloperHome | null>(null);
  const [skew, setSkew] = useState(0);
  const live = useRef(true);
  /** Reads the home; a failure throws, for the page's poll loop to weigh. */
  const poll = useCallback(async (): Promise<DeveloperHome | null> => {
    const next = await fetchHome();
    if (!live.current) return null;
    setSkew(next.now - Date.now());
    setHome(next);
    return next;
  }, []);
  const refresh = useCallback(async (): Promise<DeveloperHome | null> => {
    try {
      return await poll();
    } catch {
      // The page keeps what it has; the next read or poll tries again.
      return null;
    }
  }, [poll]);
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);
  return { home, skew, refresh, poll };
}
