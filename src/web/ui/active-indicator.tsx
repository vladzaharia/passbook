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
    // Only a change of active item slides. A resize (window, rotation, scrollbar) snaps, or the
    // pill would be caught mid-slide at a stale size.
    const place = (slide: boolean) => {
      const active = host.querySelector<HTMLElement>(ACTIVE);
      pill.hidden = !active;
      if (!active) return;
      if (!slide) delete pill.dataset.ready;
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
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        pill.dataset.ready = '';
      });
    };
    place(false);
    const mo = new MutationObserver(() => place(true));
    mo.observe(host, {
      attributes: true,
      attributeFilter: ['aria-current', 'data-state'],
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
