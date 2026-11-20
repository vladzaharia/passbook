import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanApi } from '../../api/scan-api.ts';
import type { ActivityItem } from './activity-model.ts';

/** The page is polled: a device gets no rows from the hub, so this is as live as the list gets. */
export const ACTIVITY_POLL_MS = 4000;

/**
 * The session's recent scans from every device. It loads on mount, repeats while the screen is
 * visible, and `refresh` runs it now (after this device's own scan or undo).
 */
export function useSessionActivity(api: ScanApi) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    return api.activity({ signal: own.signal }).then(
      (page) => {
        if (own.signal.aborted) return;
        setItems(page.items);
        setLoaded(true);
        setSyncedAt(Date.now());
        setUnavailable(false);
      },
      () => {
        if (!own.signal.aborted) setUnavailable(true);
      },
    );
  }, [api]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, ACTIVITY_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [refresh]);
  return { items, loaded, unavailable, syncedAt, refresh };
}
