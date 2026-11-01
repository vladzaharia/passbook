import { useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/web/lib/motion.ts';

/** The last value each tile showed this session, so a revisit starts where it left off. */
const shown = new Map<string, number>();

/** Test hook: forget what the tiles showed. */
export const resetShownCounts = () => shown.clear();

const animates = () => typeof matchMedia === 'function' && !prefersReducedMotion();

/**
 * The number to show while counting to `value`: from the last value this tile showed (0 on the
 * first visit), 600 ms ease-out. Equal values never start a frame loop, so 0 to 0 does nothing.
 */
export function useRememberedCount(id: string, value: number, ms = 600): number {
  const [current, setCurrent] = useState(() => (animates() ? (shown.get(id) ?? 0) : value));
  const last = useRef(current);
  useLayoutEffect(() => {
    const from = last.current;
    if (from === value || !animates()) {
      last.current = value;
      shown.set(id, value);
      setCurrent(value);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const n = Math.round(from + (value - from) * (1 - (1 - t) ** 3));
      last.current = n;
      shown.set(id, n);
      setCurrent(n);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [id, value, ms]);
  return current;
}
