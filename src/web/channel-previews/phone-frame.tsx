import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn.ts';

const SEED = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
const ROOT_ATTRS = ['class', 'data-theme', 'style', 'lang'] as const;

/** The app's own sheets and theme, kept in step, so the frame draws what the page draws. */
function useFrameChrome(doc: Document | null) {
  useEffect(() => {
    if (!doc) return;
    const sheets = () => {
      for (const old of doc.head.querySelectorAll('[data-from-app]')) old.remove();
      for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
        const copy = node.cloneNode(true) as HTMLElement;
        copy.setAttribute('data-from-app', '');
        doc.head.append(copy);
      }
    };
    const root = () => {
      for (const name of ROOT_ATTRS) {
        const value = document.documentElement.getAttribute(name);
        if (value === null) doc.documentElement.removeAttribute(name);
        else doc.documentElement.setAttribute(name, value);
      }
      doc.body.className = document.body.className;
    };
    sheets();
    root();
    const head = new MutationObserver(sheets);
    head.observe(document.head, { childList: true });
    const attrs = new MutationObserver(root);
    attrs.observe(document.documentElement, { attributes: true });
    return () => {
      head.disconnect();
      attrs.disconnect();
    };
  }, [doc]);
}

/**
 * A real phone-width viewport: the children are React-rendered into an iframe's document, so a
 * page that answers to the viewport (the holder's pass page) lays out as it does on a phone.
 * Same origin and same React tree: no second bundle, no HTML copy.
 */
export function PhoneFrame({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const attach = () => {
    const d = frame.current?.contentDocument;
    if (d?.body) setDoc(d);
  };
  // Once on mount; onLoad covers a frame that loads later.
  useEffect(attach, []);
  useFrameChrome(doc);
  return (
    <>
      <iframe
        ref={frame}
        title={title}
        srcDoc={SEED}
        onLoad={attach}
        className={cn('wp-phone', className)}
      />
      {doc ? createPortal(children, doc.body) : null}
    </>
  );
}
