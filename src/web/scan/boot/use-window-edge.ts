import { useEffect } from 'react';
import { nextEdge, type WindowView } from '../../../shared/session-window.ts';

const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Looks again one second after the session's hours open or close. The minute cron kicks screens
 * too, and the 10 s refetch backs both; this makes the change land on the second.
 */
export function useWindowEdge(window: WindowView | undefined, refetch: () => Promise<void>): void {
  const edge = window ? nextEdge(window) : null;
  useEffect(() => {
    if (edge === null) return;
    const wait = Math.min(Math.max(edge - Date.now() + 1000, 1000), MAX_TIMEOUT);
    const timer = setTimeout(() => void refetch(), wait);
    return () => clearTimeout(timer);
  }, [edge, refetch]);
}
