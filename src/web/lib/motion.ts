import { useRef } from 'react';

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
