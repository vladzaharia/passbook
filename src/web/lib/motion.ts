import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/** True when the user asked for less motion. False outside the browser. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type ViewTransitionDoc = Document & {
  activeViewTransition?: unknown;
  startViewTransition?: (arg: (() => void) | { update: () => void; types: string[] }) => {
    finished: Promise<void>;
  };
};

/** True while a route (or other) View Transition runs. */
export const inViewTransition = () =>
  typeof document !== 'undefined' && Boolean((document as ViewTransitionDoc).activeViewTransition);

/**
 * How a list enters: 'rise' once per mount when data that was pending arrives (rows stagger),
 * 'quiet' when it arrives during a route transition (rows only fade), false otherwise. A later
 * refetch, filter or key change never re-enters: the latch holds for the life of the component.
 */
export function useArrivalMode(pending: boolean): false | 'rise' | 'quiet' {
  const state = useRef<{ waited: boolean; mode: false | 'rise' | 'quiet' | 'done' }>({
    waited: pending,
    mode: false,
  });
  const [, settle] = useState(0);
  const s = state.current;
  if (pending && s.mode === false) s.waited = true;
  if (s.waited && !pending && s.mode === false) s.mode = inViewTransition() ? 'quiet' : 'rise';
  useEffect(() => {
    if (s.mode !== 'rise' && s.mode !== 'quiet') return;
    // Drop the entrance class after the stagger, so rows added later do not rise.
    const t = setTimeout(() => {
      s.mode = 'done';
      settle((n) => n + 1);
    }, 600);
    return () => clearTimeout(t);
  }, [s, s.mode]);
  return s.mode === 'done' ? false : s.mode;
}

/** True once data that was pending at mount has arrived (see useArrivalMode). */
export function useArrival(pending: boolean): boolean {
  return useArrivalMode(pending) !== false;
}

/**
 * Ids new since the previous render (first load excluded): rows set data-new and get the accent
 * wash (motion.css). The set holds until the ids change again.
 */
export function useInsertHighlight(ids: readonly string[]): ReadonlySet<string> {
  const state = useRef<{ key: string; seen: Set<string> | null; fresh: Set<string> }>({
    key: '',
    seen: null,
    fresh: new Set(),
  });
  const key = ids.join('\u0000');
  const s = state.current;
  if (s.key !== key) {
    const seen = s.seen;
    s.fresh = seen ? new Set(ids.filter((id) => !seen.has(id))) : new Set();
    s.key = key;
    if (seen || ids.length) s.seen = new Set(ids);
  }
  return s.fresh;
}

/**
 * Removes a row with a same-document View Transition: rows marked data-row-id get a
 * view-transition-name for its duration, the removed one shrinks and fades (160 ms) and the
 * neighbours close up (240 ms). Without support, or under reduced motion, it updates at once.
 */
export function removeWithTransition(update: () => void): void {
  const doc = document as ViewTransitionDoc;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }
  const rows = [...document.querySelectorAll<HTMLElement>('[data-row-id]')];
  for (const row of rows) {
    row.style.setProperty('view-transition-name', `row-${row.dataset.rowId}`);
    row.style.setProperty('view-transition-class', 'row');
  }
  const root = document.documentElement;
  root.dataset.removing = '';
  const run = () => flushSync(update);
  const typed = CSS.supports('selector(:active-view-transition-type(a))');
  const transition = doc.startViewTransition(typed ? { update: run, types: ['row'] } : run);
  void transition.finished.finally(() => {
    delete root.dataset.removing;
    for (const row of rows) {
      row.style.removeProperty('view-transition-name');
      row.style.removeProperty('view-transition-class');
    }
  });
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

/** True once `pending` has lasted `ms`: loading states and waiting beats that would only flash stay off. */
export function useLasting(pending: boolean, ms = 150): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!pending) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [pending, ms]);
  return on;
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
