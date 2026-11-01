import { useLayoutEffect, useRef } from 'react';

const ACTIVE = [
  '[aria-current="page"]',
  '[role="tab"][data-state="active"]',
  '[role="radio"][aria-checked="true"]',
  '[role="menuitemradio"][aria-checked="true"]',
  '[role="option"][aria-selected="true"]',
].join(', ');

export type IndicatorVariant = 'pill' | 'underline' | 'thumb' | 'list';

/**
 * A pill, underline or segmented thumb behind the active item in its parent: aria-current="page",
 * an active tab or a checked radio. It slides with a transform (280 ms spring) and takes the new
 * width directly, so nothing scales at rest. The parent must be position: relative and its items
 * positioned so they paint above it.
 */
export function ActiveIndicator({ variant = 'pill' }: { variant?: IndicatorVariant }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement;
    if (!pill || !host) return;
    let frame = 0;
    // Only a change of active item slides. A resize (window, rotation, scrollbar) snaps, or the
    // pill would be caught mid-slide at a stale size.
    const place = (slide: boolean) => {
      const active = host.querySelector<HTMLElement>(ACTIVE);
      pill.hidden = !active;
      if (!active) return;
      if (!slide) delete pill.dataset.ready;
      const underline = variant === 'underline';
      const h = underline ? 2 : active.offsetHeight;
      const y = underline ? active.offsetTop + active.offsetHeight - 2 : active.offsetTop;
      pill.style.width = `${active.offsetWidth}px`;
      pill.style.height = `${h}px`;
      pill.style.transform = `translate(${active.offsetLeft}px, ${y}px)`;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        pill.dataset.ready = '';
      });
    };
    place(false);
    const mo = new MutationObserver(() => place(true));
    mo.observe(host, {
      attributes: true,
      attributeFilter: ['aria-current', 'data-state', 'aria-checked', 'aria-selected'],
      childList: true,
      subtree: true,
    });
    const ro =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => place(false));
    ro?.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      ro?.disconnect();
    };
  }, [variant]);
  return <span ref={ref} aria-hidden className="wl-indicator" data-variant={variant} />;
}
