import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  type PointerEvent,
  type ReactNode,
  useContext,
  useRef,
} from 'react';
import { cn } from '../lib/cn.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { DialogOverlay, OVERLAY_TITLE, restoreOpener, useOpener } from './overlay.tsx';

const SheetOpener = createContext<{ current: HTMLElement | null } | null>(null);
const SheetClose = createContext<(() => void) | null>(null);

export function Sheet({ onOpenChange, ...props }: ComponentProps<typeof DialogPrimitive.Root>) {
  const opener = useOpener(props.open);
  return (
    <SheetOpener.Provider value={opener}>
      <SheetClose.Provider value={onOpenChange ? () => onOpenChange(false) : null}>
        <DialogPrimitive.Root onOpenChange={onOpenChange} {...props} />
      </SheetClose.Provider>
    </SheetOpener.Provider>
  );
}
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetCloseButton = DialogPrimitive.Close;

export interface SheetContentProps
  extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  side?: 'left' | 'right';
  hideTitle?: boolean;
  /** Visible header content (the wordmark on the nav sheet); the title stays the name. */
  header?: ReactNode;
}

/**
 * Touch drag to close: the sheet follows the finger (touch-action pan-y keeps vertical scrolling),
 * the overlay fades with it; past 40% of the width or 0.5 px/ms it closes, else springs back.
 */
function useDragToClose(side: 'left' | 'right') {
  const close = useContext(SheetClose);
  const content = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; t: number; dx: number; on: boolean } | null>(null);
  const dir = side === 'left' ? -1 : 1;
  const reset = (el: HTMLElement) => {
    el.style.transition = 'transform 200ms var(--wl-ease-spring)';
    el.style.transform = '';
    if (overlay.current) overlay.current.style.opacity = '';
    el.addEventListener('transitionend', () => (el.style.transition = ''), { once: true });
  };
  return {
    content,
    overlay,
    handlers: {
      onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
        if (e.pointerType !== 'touch' || !close) return;
        drag.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, on: false };
      },
      onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        const el = content.current;
        if (!d || !el) return;
        const dx = e.clientX - d.x;
        if (!d.on) {
          // A vertical gesture is a scroll; give it back.
          if (Math.abs(e.clientY - d.y) > 8 && Math.abs(e.clientY - d.y) > Math.abs(dx)) {
            drag.current = null;
            return;
          }
          if (Math.abs(dx) < 8) return;
          d.on = true;
          el.setPointerCapture(e.pointerId);
        }
        d.dx = dir < 0 ? Math.min(0, dx) : Math.max(0, dx);
        if (prefersReducedMotion()) return;
        el.style.transform = `translateX(${d.dx}px)`;
        if (overlay.current) {
          overlay.current.style.opacity = String(1 - Math.abs(d.dx) / el.offsetWidth);
        }
      },
      onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        const el = content.current;
        drag.current = null;
        if (!d?.on || !el) return;
        const speed = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t);
        if (Math.abs(d.dx) > el.offsetWidth * 0.4 || speed > 0.5) close?.();
        else reset(el);
      },
      onPointerCancel: () => {
        drag.current = null;
        if (content.current) reset(content.current);
      },
    },
  };
}

export function SheetContent({
  title,
  side = 'right',
  hideTitle,
  header,
  className,
  children,
  onCloseAutoFocus,
  ...props
}: SheetContentProps) {
  const opener = useContext(SheetOpener);
  const { content, overlay, handlers } = useDragToClose(side);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay ref={overlay} />
      <DialogPrimitive.Content
        ref={content}
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (!e.defaultPrevented) restoreOpener(opener)(e);
        }}
        {...handlers}
        className={cn(
          'fixed inset-y-0 z-50 flex w-72 max-w-[calc(100%-1rem)] touch-pan-y flex-col border-border bg-surface-raised shadow-elevation-3',
          'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
          side === 'left'
            ? 'wl-sheet-left left-0 border-r pl-[env(safe-area-inset-left)]'
            : 'wl-sheet-right right-0 border-l pr-[env(safe-area-inset-right)] max-sm:w-[calc(100%-1rem)] sm:w-96',
          className,
        )}
        {...props}
      >
        <div className="flex min-h-14 items-center justify-between gap-2 border-b border-border px-4 py-2">
          {header}
          <DialogPrimitive.Title className={cn(OVERLAY_TITLE, (hideTitle || header) && 'sr-only')}>
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label="Close"
            className="relative ml-auto inline-flex size-8 items-center justify-center rounded-md text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong pointer-coarse:size-11"
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
