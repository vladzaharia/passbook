import { useEffect, useState } from 'react';

/**
 * The element's width, live. Pass the setter it returns as the element's ref. The viewport says
 * little at tablet width: the sidebar leaves a column of its own.
 */
export function useContainerWidth(): [number, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [width, setEl];
}
