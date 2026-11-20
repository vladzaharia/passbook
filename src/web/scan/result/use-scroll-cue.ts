import { type RefObject, useLayoutEffect } from 'react';

/**
 * Marks `el` with `data-more` while there is more to scroll to below, so a fade can say so. It
 * follows the scroll and any size change of the box or what is in it (text zoom, a note).
 */
export function useScrollCue(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      el.toggleAttribute('data-more', el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    update();
    el.addEventListener('scroll', update, { passive: true });
    if (typeof ResizeObserver === 'undefined')
      return () => el.removeEventListener('scroll', update);
    const watch = new ResizeObserver(update);
    watch.observe(el);
    for (const child of el.children) watch.observe(child);
    return () => {
      el.removeEventListener('scroll', update);
      watch.disconnect();
    };
  }, [ref]);
}
