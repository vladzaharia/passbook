import { useLayoutEffect, useRef } from 'react';

/**
 * A pill behind the item marked aria-current="page" (or data-state="active") in its parent.
 * It slides to the new item on change with a transform; the parent must be position: relative
 * and its items positioned so they paint above it.
 */
export function ActiveIndicator({ watch }: { watch: unknown }) {
  const ref = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: watch is the trigger
  useLayoutEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement;
    if (!pill || !host) return;
    const place = () => {
      const active = host.querySelector<HTMLElement>(
        '[aria-current="page"], [data-state="active"]',
      );
      pill.hidden = !active;
      if (!active) return;
      const w = active.offsetWidth;
      // Width is fixed at first placement; later widths scale so only transform animates.
      pill.dataset.base ??= String(w);
      const base = Number(pill.dataset.base) || w;
      pill.style.width = `${base}px`;
      pill.style.height = `${active.offsetHeight}px`;
      pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px) scaleX(${w / base})`;
      // Placed once without motion; later changes slide.
      requestAnimationFrame(() => {
        pill.dataset.ready = '';
      });
    };
    place();
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    ro?.observe(host);
    return () => ro?.disconnect();
  }, [watch]);
  return <span ref={ref} aria-hidden className="wl-indicator" />;
}
