import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface FrameSize {
  width: number;
  height: number;
}

/** A scanner is a full-viewport page: the frame is its viewport, so its media queries answer. */
export const FRAME_SIZES = {
  phone: { width: 390, height: 844 },
  ipad: { width: 820, height: 1180 },
  desk: { width: 1180, height: 760 },
} as const satisfies Record<string, FrameSize>;

const SHELL =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
  '<body><div id="root"></div></body></html>';

function copyStyles(from: Document, to: Document) {
  const seen = new Set(
    Array.from(to.head.querySelectorAll('[data-sp-clone]'), (el) =>
      el.getAttribute('data-sp-clone'),
    ),
  );
  for (const node of from.head.querySelectorAll('link[rel="stylesheet"], style')) {
    const key =
      node.getAttribute('href') ?? node.getAttribute('data-vite-dev-id') ?? node.textContent ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    const clone = node.cloneNode(true) as Element;
    clone.setAttribute('data-sp-clone', key);
    to.head.append(clone);
  }
}

/**
 * Hosts the scanner's own screen in a same-origin document of the device's size, scaled to fit.
 * The scanner's CSS is written for a page (root tokens, fixed layers, viewport queries), so it
 * runs in one; nothing in it is restyled for the designer.
 */
export function ScanFrame({
  device,
  theme,
  label,
  children,
  onLayout,
  overlay,
}: {
  device: keyof typeof FRAME_SIZES;
  theme: 'light' | 'dark';
  label: string;
  children: ReactNode;
  /** The frame's document and its scale, whenever either changes. */
  onLayout?: (doc: Document, scale: number) => void;
  /** Drawn over the frame in the designer's own document. */
  overlay?: ReactNode;
}) {
  const size = FRAME_SIZES[device];
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [scale, setScale] = useState(1);
  const onLoad = useCallback(() => {
    const doc = frame.current?.contentDocument;
    const root = doc?.getElementById('root');
    if (!doc || !root) return;
    copyStyles(document, doc);
    setMount(root);
  }, []);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!mount || !doc) return;
    doc.documentElement.dataset.theme = theme;
    const watch = new MutationObserver(() => copyStyles(document, doc));
    watch.observe(document.head, { childList: true });
    return () => watch.disconnect();
  }, [mount, theme]);
  useEffect(() => {
    const el = box.current?.parentElement;
    if (!el) return;
    const measure = () => {
      const room = el.clientWidth - 24;
      if (room > 0) setScale(Math.min(device === 'phone' ? 0.85 : 1, room / size.width));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [device, size.width]);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (mount && doc) onLayout?.(doc, scale);
  }, [mount, scale, onLayout]);
  return (
    <div
      ref={box}
      className="sp-device"
      data-device={device}
      style={{ width: size.width * scale, height: size.height * scale }}
    >
      <iframe
        ref={frame}
        title={label}
        srcDoc={SHELL}
        onLoad={onLoad}
        className="sp-frame"
        width={size.width}
        height={size.height}
        style={{ transform: `scale(${scale})` }}
      />
      {mount ? createPortal(children, mount) : null}
      {overlay}
    </div>
  );
}
