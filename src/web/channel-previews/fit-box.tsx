import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { useContainerWidth } from '../lib/container-width.ts';
import './fit-box.css';

/**
 * Shows its content whole, whatever its shape: laid out once at `layoutWidth`, then scaled down
 * (or up) to fit the box's width and `maxHeight` together. A portrait page, a landscape card, two
 * pages stacked or a long strip all fit without a crop; nothing is assumed about the aspect ratio.
 */
export function FitBox({
  children,
  maxHeight,
  layoutWidth = 480,
  className,
}: {
  children: ReactNode;
  /** The tallest the content may draw, in px. */
  maxHeight: number;
  /** The width the content lays out at before it is scaled; a page is drawn from its width alone. */
  layoutWidth?: number;
  className?: string;
}) {
  const [avail, measure] = useContainerWidth();
  const inner = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState(0);
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => setNatural(el.offsetHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = avail > 0 && natural > 0 ? Math.min(avail / layoutWidth, maxHeight / natural) : 0;
  return (
    <div ref={measure} className={cn('fit', className)} data-fit={scale > 0 ? '' : undefined}>
      <div
        className="fit-sized"
        style={scale > 0 ? { width: layoutWidth * scale, height: natural * scale } : undefined}
      >
        <div
          ref={inner}
          className="fit-inner"
          style={{ width: layoutWidth, transform: `scale(${scale || 1})` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
