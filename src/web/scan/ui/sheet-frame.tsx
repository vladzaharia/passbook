import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type PointerEvent, type ReactNode, useRef, useState } from 'react';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { prefersReducedMotion } from '../../lib/motion.ts';
import { DialogOverlay, focusInitial, restoreOpener, useOpener } from '../../ui/overlay.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import './scan-sheet.css';

export type Snap = 'full' | 'half';

/**
 * Pulling the grab area: down 90 px (or fast) steps 700 to 460 and closes from 460; up 60 px
 * from 460 goes back to 700. Short of that it settles where it was. No bounce.
 */
export function useSnapDrag(snap: Snap, setSnap: (snap: Snap) => void, onClose: () => void) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const settle = () => {
    if (!el.current) return;
    const node = el.current;
    node.style.transition = 'transform 180ms var(--wl-ease-out)';
    node.style.transform = '';
    node.addEventListener('transitionend', () => (node.style.transition = ''), { once: true });
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
        d.dy = e.clientY - d.y;
        if (!prefersReducedMotion())
          el.current.style.transform = `translateY(${Math.max(0, d.dy)}px)`;
      },
      onPointerUp: (e: PointerEvent) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const fast = d.dy > 40 && d.dy / Math.max(1, e.timeStamp - d.t) > 0.5;
        if (el.current) el.current.style.transform = '';
        if (d.dy > 90 || fast) {
          if (snap === 'full') setSnap('half');
          else onClose();
        } else if (d.dy < -60 && snap === 'half') setSnap('full');
        else settle();
      },
      onPointerCancel: () => {
        drag.current = null;
        settle();
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
  /** A 560 tray (This shift) instead of the 700 sheet: one height, a pull down closes. */
  tray?: boolean;
}

/**
 * The handheld's one sheet (design 6): a 700 px bottom sheet (snap 460) with a grab handle, a header, a scrolling
 * body and a thumb footer. At 640 and up it is the side sheet every other scanner panel uses.
 */
export function SheetFrame({ label, onClose, header, children, footer, tray }: SheetFrameProps) {
  const phone = useMediaQuery(PHONE);
  const opener = useOpener(true);
  const [snap, setSnap] = useState<Snap>(tray ? 'half' : 'full');
  const swipe = useSnapDrag(snap, setSnap, onClose);
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
          data-snap={snap}
          data-tray={tray || undefined}
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
