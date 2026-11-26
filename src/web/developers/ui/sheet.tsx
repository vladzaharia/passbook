import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import './sheet.css';

/** A real browser that has not asked for reduced motion: only then does a sheet play its way out. */
const animates = () =>
  typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The exit is 160 ms (sheet.css); the timer only backs up a missed `animationend`. */
const EXIT_MS = 200;

/**
 * The portal's one modal sheet, on the native dialog: a side panel from 720 px, a bottom sheet below.
 * Escape and the backdrop close it unless `guard` holds (a secret not yet copied); the close button
 * always does. Closing plays the exit first, then calls `onClose`; focus goes back to the opener.
 */
export function Sheet({
  title,
  onClose,
  guard = false,
  onBlocked,
  footer,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  guard?: boolean;
  /** Escape or a backdrop tap met the guard. */
  onBlocked?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const leaving = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    opener.current = document.activeElement;
    if (!d.open) d.showModal();
    // Focus may land on a field far down the body: the sheet opens on its top.
    const top = () => d.querySelector('.sheet-b')?.scrollTo?.(0, 0);
    top();
    const frame = requestAnimationFrame(top);
    document.documentElement.dataset.sheet = 'open';
    return () => {
      cancelAnimationFrame(frame);
      delete document.documentElement.dataset.sheet;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  const dismiss = useCallback(() => {
    const d = ref.current;
    if (leaving.current) return;
    if (!d || !animates()) return onClose();
    leaving.current = true;
    d.dataset.closing = '';
    const done = () => {
      clearTimeout(timer);
      onClose();
    };
    const timer = setTimeout(done, EXIT_MS);
    d.addEventListener('animationend', done, { once: true });
  }, [onClose]);
  const ask = () => {
    if (guard) onBlocked?.();
    else dismiss();
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap on the backdrop closes; Escape is the cancel event
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        ask();
      }}
      // A second Escape can close the dialog without a cancel event: put it back while guarded.
      onClose={() => {
        if (guard) ref.current?.showModal();
        else if (!leaving.current) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) ask();
      }}
    >
      <div className="sheet-h">
        <span className="sheet-grab" aria-hidden="true" />
        <h2 id={titleId} className="h3">
          {title}
        </h2>
        {guard ? null : (
          <button
            type="button"
            className="btn ghost sm sheet-x"
            aria-label={KEYS_COPY.sheet.close}
            onClick={dismiss}
          >
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="sheet-b">{children}</div>
      {footer ? <div className="sheet-f">{footer}</div> : null}
    </dialog>
  );
}
