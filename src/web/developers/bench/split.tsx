import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { useMediaQuery } from '../../lib/media.ts';

/** The frame's one wide breakpoint: from here the pane sits beside the main column. */
export const BENCH_WIDE = '(min-width: 1180px)';

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The pane below 1180 px: a modal dialog, a drawer from its edge from 720 px and a bottom sheet below.
 * Escape, the backdrop and Close call `onClose`; closing plays the exit (160 ms) and gives focus back
 * to what opened it.
 */
function PaneDialog({
  open,
  onClose,
  label,
  edge,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  edge: 'start' | 'end';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      delete d.dataset.closing;
      d.showModal();
      return;
    }
    if (open || !d.open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      delete d.dataset.closing;
      d.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
    if (reduced()) return done();
    d.dataset.closing = '';
    timer = setTimeout(done, 200);
    d.addEventListener('animationend', done, { once: true });
    return () => {
      clearTimeout(timer);
      d.removeEventListener('animationend', done);
    };
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap on the backdrop closes; Escape is the cancel event
    <dialog
      ref={ref}
      className="bench-sheet"
      data-edge={edge}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="bench-sheet-h">
        <span className="bench-grab" aria-hidden="true" />
        <button
          type="button"
          className="btn ghost sm bench-sheet-x"
          aria-label={BENCH_COPY.pane.close}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="bench-sheet-b">{children}</div>
    </dialog>
  );
}

/**
 * The bench body's two panes. `split` (Webhooks, Logs, Keys): the list, and the inspector beside it.
 * `index` (Console): the operation index, and the stage beside it. From 1180 px the pane is a sticky
 * column with its own scroll; below, it opens over the page when `open` (a drawer from its edge, a
 * bottom sheet under 720 px) and the main column takes the width.
 */
export function BenchSplit({
  layout = 'split',
  main,
  pane,
  open,
  onClose,
  label,
}: {
  layout?: 'split' | 'index';
  /** The list (split) or the stage (index). */
  main: ReactNode;
  /** The inspector (split) or the operation index (index). */
  pane: ReactNode;
  /** Below 1180 px: the drawer or sheet is open. */
  open: boolean;
  onClose: () => void;
  /** The pane's name, for its landmark and its dialog. */
  label: string;
}) {
  const wide = useMediaQuery(BENCH_WIDE);
  const side = wide ? (
    <aside className="bench-pane" aria-label={label}>
      {pane}
    </aside>
  ) : null;
  return (
    <div className="bench-split" data-layout={layout}>
      {layout === 'index' ? side : null}
      <div className="bench-main">{main}</div>
      {layout === 'split' ? side : null}
      {wide ? null : (
        <PaneDialog
          open={open}
          onClose={onClose}
          label={label}
          edge={layout === 'index' ? 'start' : 'end'}
        >
          {pane}
        </PaneDialog>
      )}
    </div>
  );
}
