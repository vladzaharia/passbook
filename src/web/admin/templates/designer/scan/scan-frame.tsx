import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  operator: { width: 1366, height: 768 },
} as const satisfies Record<string, FrameSize>;

/** Builds the frame's page with DOM calls: Trusted Types forbids `document.write` in production. */
function buildShell(doc: Document) {
  doc.documentElement.lang = 'en';
  const meta = doc.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1';
  doc.head.append(meta);
  const root = doc.createElement('div');
  root.id = 'root';
  doc.body.append(root);
}

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
  // A blank frame gets its page written in; a browser that swaps the blank document after load
  // is answered by the load handler, which writes it again.
  const init = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    if (!doc.getElementById('root')) {
      buildShell(doc);
    }
    const root = doc.getElementById('root');
    if (!root) return;
    copyStyles(document, doc);
    setMount(root);
  }, []);
  useLayoutEffect(init, [init]);
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
        onLoad={init}
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

/** The frame's document and scale as state, with a callback stable enough for `onLayout`. */
export function useFrameLayout() {
  const [layout, setLayout] = useState<{ doc: Document; scale: number } | null>(null);
  const onLayout = useCallback(
    (doc: Document, scale: number) =>
      setLayout((prev) => (prev?.doc === doc && prev.scale === scale ? prev : { doc, scale })),
    [],
  );
  return [layout, onLayout] as const;
}
