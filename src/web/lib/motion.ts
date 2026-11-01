import { useLayoutEffect, useRef } from 'react';

/** True when the user asked for less motion. False outside the browser. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * True once data that was pending at mount has arrived. Entrance animations use it so cached
 * data (already on screen through the route transition) does not animate twice.
 */
export function useArrival(pending: boolean): boolean {
  const waited = useRef(pending);
  if (pending) waited.current = true;
  return waited.current && !pending;
}

const depth = (path: string) => path.split('/').filter(Boolean).length;

/**
 * View transition types for a navigation, or false for none. Only path changes animate:
 * search-param changes (filters, ?tab=) must stay instant.
 */
export function routeTransitionTypes(info: {
  fromLocation?: { pathname: string };
  toLocation: { pathname: string };
  pathChanged: boolean;
}): string[] | false {
  if (!info.pathChanged || !info.fromLocation || prefersReducedMotion()) return false;
  const from = depth(info.fromLocation.pathname);
  const to = depth(info.toLocation.pathname);
  return [to > from ? 'forward' : to < from ? 'back' : 'swap'];
}

/** Router option: only where transition types exist, so search changes never animate. */
export function viewTransitionOption() {
  const typed =
    typeof CSS !== 'undefined' &&
    typeof document !== 'undefined' &&
    'startViewTransition' in document &&
    CSS.supports('selector(:active-view-transition-type(a))');
  return typed ? { types: routeTransitionTypes } : false;
}

/** Counts renders where `value` changed after mount: a key that replays a one-shot animation. */
export function useChangeCount(value: unknown): number {
  const prev = useRef(value);
  const count = useRef(0);
  if (!Object.is(prev.current, value)) {
    prev.current = value;
    count.current += 1;
  }
  return count.current;
}

/**
 * Writes a number into `ref`, counting to `value`: from 0 on mount, from the shown value on
 * change. The element renders the final text, so tests and reduced motion see it as is.
 */
export function useCountUp(
  ref: { current: HTMLElement | null },
  value: number,
  format: (n: number) => string,
  ms = 600,
) {
  const shown = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      shown.current = value;
      return;
    }
    const from = shown.current;
    if (from === value) return;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const n = Math.round(from + (value - from) * (1 - (1 - t) ** 3));
      shown.current = n;
      el.textContent = format(n);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    el.textContent = format(from);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.textContent = format(value);
      shown.current = value;
    };
  }, [ref, value, format, ms]);
}
