import { useEffect, useState } from 'react';

const match = (query: string) =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;

/** Tracks a media query; false outside the browser. */
export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => match(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return on;
}

export const PHONE = '(max-width: 639.98px)';
export const BELOW_MD = '(max-width: 767.98px)';
export const BELOW_LG = '(max-width: 1023.98px)';
export const BELOW_XL = '(max-width: 1279.98px)';
export const FINE_POINTER = '(hover: hover) and (pointer: fine)';
export const COARSE_ONLY = '(pointer: coarse) and (not (any-pointer: fine))';
