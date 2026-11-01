import { useLayoutEffect, useRef } from 'react';

const ACTIVE = '[aria-current="page"], [role="tab"][data-state="active"]';

/**
 * A pill (or underline) behind the active item in its parent: aria-current="page" or an active
 * tab. It follows changes on its own and slides with a transform. The parent must be
 * position: relative and its items positioned so they paint above it.
 */
export function ActiveIndicator({ variant = 'pill' }: { variant?: 'pill' | 'underline' }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement;
    if (!pill || !host) return;
    let frame = 0;
    const place = () => {
      const active = host.querySelector<HTMLElement>(ACTIVE);
      pill.hidden = !active;
      if (!active) return;
      const w = active.offsetWidth;
      // Width is fixed at first placement; later widths scale, so only transform animates.
      pill.dataset.base ??= String(w);
      const base = Number(pill.dataset.base) || w;
      const h = variant === 'underline' ? 2 : active.offsetHeight;
      const y =
        variant === 'underline' ? active.offsetTop + active.offsetHeight - 2 : active.offsetTop;
      pill.style.width = `${base}px`;
      pill.style.height = `${h}px`;
      pill.style.transform = `translate(${active.offsetLeft}px, ${y}px) scaleX(${w / base})`;
      // Placed once without motion; later changes slide.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        pill.dataset.ready = '';
      });
    };
    place();
    const mo = new MutationObserver(place);
    mo.observe(host, {
      attributes: true,
      attributeFilter: ['aria-current', 'data-state'],
      subtree: true,
    });
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    ro?.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      ro?.disconnect();
    };
  }, [variant]);
  return <span ref={ref} aria-hidden className="wl-indicator" data-variant={variant} />;
}
