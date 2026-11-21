import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';

/**
 * A modal sheet on the native dialog: a side panel on a wide screen, a bottom sheet on a phone. Escape and the
 * backdrop call `onClose` unless `guard` holds (a secret not yet copied); the close button always does.
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
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    opener.current = document.activeElement;
    if (!d.open) d.showModal();
    document.documentElement.dataset.sheet = 'open';
    return () => {
      delete document.documentElement.dataset.sheet;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap on the backdrop closes; Escape is the cancel event
    <dialog
      ref={ref}
      className="ks-sheet"
      aria-labelledby="ks-title"
      onCancel={(e) => {
        e.preventDefault();
        if (guard) onBlocked?.();
        else onClose();
      }}
      // A second Escape can close the dialog without a cancel event: put it back while guarded.
      onClose={() => {
        if (guard) ref.current?.showModal();
        else onClose();
      }}
      onClick={(e) => {
        if (e.target !== ref.current) return;
        if (guard) onBlocked?.();
        else onClose();
      }}
    >
      <div className="ks-h">
        <span className="ks-grab" aria-hidden="true" />
        <h2 id="ks-title" className="h3">
          {title}
        </h2>
        {guard ? null : (
          <button
            type="button"
            className="btn ghost sm ks-x"
            aria-label={KEYS_COPY.sheet.close}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="ks-b">{children}</div>
      {footer ? <div className="ks-f">{footer}</div> : null}
    </dialog>
  );
}
