import { useEffect, useState } from 'react';

/** True once `active` has lasted `afterMs`: the "taking longer" hint. Resets when `active` ends. */
export function useSlow(active: boolean, afterMs = 30_000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(t);
  }, [active, afterMs]);
  return slow;
}

/** Whole seconds since `since`, ticking while `running`; frozen at `stopAt` once there is one. */
export function useElapsed(since: number, running: boolean, stopAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return Math.max(0, Math.floor(((stopAt ?? now) - since) / 1000));
}
