import { useLayoutEffect, useState } from 'react';
import { formatCount } from '@/web/lib/format.ts';
import { prefersReducedMotion } from '@/web/lib/motion.ts';

const MS = 600;

/**
 * `to` at rest. When `playKey` changes (a pick), it counts from `from` to `to` over 600 ms; with no
 * `from` (no limit) or under reduced motion it just shows `to`.
 */
function useTween(to: number, from: number | null | undefined, playKey: number): number {
  const [shown, setShown] = useState(to);
  useLayoutEffect(() => {
    if (playKey === 0 || from == null || from === to || prefersReducedMotion()) {
      setShown(to);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / MS);
      setShown(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    setShown(from);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, from, playKey]);
  return shown;
}

/** A count that follows a pick; `∞` fades in instead of counting. */
export function PlanNumber({
  value,
  from,
  playKey,
}: {
  value: number | null;
  from: number | null | undefined;
  playKey: number;
}) {
  const shown = useTween(value ?? 0, from, playKey);
  if (value === null)
    return (
      <span
        key={playKey}
        aria-hidden
        className={playKey > 0 ? 'plan-fade text-2xl leading-none' : 'text-2xl leading-none'}
      >
        {'∞'}
      </span>
    );
  return <span className="tabular-nums">{formatCount(shown)}</span>;
}
