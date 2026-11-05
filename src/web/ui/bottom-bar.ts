import { useEffect, useState } from 'react';

/** Bars fixed to the bottom of the screen and their heights; the tallest is published. */
const bars = new Map<object, number>();

function publish() {
  const root = document.documentElement;
  const height = Math.max(0, ...bars.values());
  if (height > 0) root.style.setProperty('--wl-bottom-bar', `${height}px`);
  else root.style.removeProperty('--wl-bottom-bar');
}

/**
 * Publishes a fixed bottom bar's height as --wl-bottom-bar on the root, so toasts sit above it
 * (toaster.tsx). Put the returned ref on the bar's element.
 */
export function useBottomBar<T extends HTMLElement>(): (el: T | null) => void {
  const [el, setEl] = useState<T | null>(null);
  useEffect(() => {
    if (!el) return;
    const key = {};
    const measure = () => {
      bars.set(key, el.offsetHeight);
      publish();
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      bars.delete(key);
      publish();
    };
  }, [el]);
  return setEl;
}
