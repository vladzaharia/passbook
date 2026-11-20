import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type PointerEvent, type ReactNode, useRef } from 'react';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { prefersReducedMotion } from '../../lib/motion.ts';
import { DialogOverlay, focusInitial, restoreOpener, useOpener } from '../../ui/overlay.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import './scan-sheet.css';

/** Pulling the grab area down 90 px, or fast, closes the sheet; short of that it springs back. */
function useSwipeDown(onClose: () => void) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const reset = () => {
    if (!el.current) return;
    el.current.style.transition = 'transform 180ms var(--wl-ease-out)';
    el.current.style.transform = '';
  };
  return {
    ref: el,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        drag.current = { y: e.clientY, t: e.timeStamp, dy: 0 };
        e.currentTarget.setPointerCapture(e.pointerId);
        if (el.current) el.current.style.transition = '';
      },
      onPointerMove: (e: PointerEvent) => {
        const d = drag.current;
        if (!d || !el.current) return;
        d.dy = Math.max(0, e.clientY - d.y);
        if (!prefersReducedMotion()) el.current.style.transform = `translateY(${d.dy}px)`;
      },
      onPointerUp: (e: PointerEvent) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.dy > 90 || d.dy / Math.max(1, e.timeStamp - d.t) > 0.5) onClose();
        else reset();
      },
      onPointerCancel: () => {
        drag.current = null;
        reset();
      },
    },
  };
}

export interface SheetFrameProps {
  /** The accessible name of the dialog. */
  label: string;
  onClose: () => void;
  /** Who: tile or photo, name, meta. The frame adds the close button. */
  header: ReactNode;
  children: ReactNode;
  /** The thumb row: at most two buttons. */
  footer?: ReactNode;
}

/**
 * The handheld's one sheet (design 6): a 700 px bottom sheet with a grab handle, a header, a scrolling
 * body and a thumb footer. At 640 and up it is the side sheet every other scanner panel uses.
 */
export function SheetFrame({ label, onClose, header, children, footer }: SheetFrameProps) {
  const phone = useMediaQuery(PHONE);
  const opener = useOpener(true);
  const swipe = useSwipeDown(onClose);
  if (!phone)
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()}>
        <SheetContent title={label} className="scan-detail-sheet">
          <div className="scan-sheet-col">
            <div className="scan-sheet-head">{header}</div>
            <div className="scan-sheet-scroll">{children}</div>
            {footer ? <div className="scan-sheet-foot">{footer}</div> : null}
          </div>
        </SheetContent>
      </Sheet>
    );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <DialogOverlay />
        <Dialog.Content
          ref={swipe.ref}
          aria-describedby={undefined}
          className="scan-pass-sheet wl-dialog"
          onOpenAutoFocus={focusInitial}
          onCloseAutoFocus={restoreOpener(opener)}
        >
          <Dialog.Title className="scan-sr">{label}</Dialog.Title>
          <div className="scan-sheet-grab" {...swipe.handlers}>
            <span aria-hidden />
          </div>
          <div className="scan-sheet-head">
            {header}
            <Dialog.Close aria-label="Close" className="scan-sheet-x">
              <X aria-hidden size={22} />
            </Dialog.Close>
          </div>
          <div className="scan-sheet-scroll">{children}</div>
          {footer ? <div className="scan-sheet-foot">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
