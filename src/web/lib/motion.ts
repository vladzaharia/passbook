import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
 * The number to show while counting to `value`: from 0 on mount, from the shown number on change,
 * 600 ms ease-out. Without a layout engine (tests) or with reduced motion it is `value`.
 */
export function useCountUp(value: number, ms = 600): number {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useLayoutEffect(() => {
    if (typeof matchMedia !== 'function' || prefersReducedMotion()) {
      last.current = value;
      setShown(value);
      return;
    }
    const from = last.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const n = Math.round(from + (value - from) * (1 - (1 - t) ** 3));
      last.current = n;
      setShown(n);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    setShown(from);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return shown;
}

const minted = new Set<string>();
/** Marks a pass as just created so its detail page mints the card on arrival. */
export const markMinted = (id: string) => void minted.add(id);
/** True once for a pass marked by markMinted. */
export function useMintedOnArrival(id: string): boolean {
  const [fresh] = useState(() => minted.has(id));
  useEffect(() => {
    minted.delete(id);
  }, [id]);
  return fresh;
}
