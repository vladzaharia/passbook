import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';

/** Tracks whether a horizontal scroller has more content to either side. */
export function useEdgeFade() {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);
  return { ref, fade, measure };
}

/** A 32 px fade on the side of a scroller that has more content. */
export function EdgeFade({ side, show }: { side: 'start' | 'end'; show: boolean }) {
  if (!show) return null;
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-px w-8 from-surface-raised to-transparent',
        side === 'start'
          ? 'left-px rounded-l-lg bg-gradient-to-r'
          : 'right-px rounded-r-lg bg-gradient-to-l',
      )}
    />
  );
}
