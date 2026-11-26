import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
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
  side?: 'left' | 'right' | 'bottom';
  hideTitle?: boolean;
  /** No Close button: the sheet cannot be dismissed (a step that must be finished). */
  hideClose?: boolean;
  /** Visible header content (the wordmark on the nav sheet); the title stays the name. */
  header?: ReactNode;
  /** Actions pinned under the scroll body, never over it (a submit button joins its form with `form`). */
  footer?: ReactNode;
}

/**
 * Touch drag to close: the sheet follows the finger (touch-action pan-y keeps vertical scrolling),
 * the overlay fades with it; past 40% of the width or 0.5 px/ms it closes, else springs back.
 */
function useDragToClose(side: 'left' | 'right' | 'bottom') {
  const close = useContext(SheetClose);
  const content = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; t: number; dx: number; on: boolean } | null>(null);
  const dir = side === 'left' ? -1 : 1;
  // The bottom sheet drags down from its header (its body scrolls); the side sheets drag sideways.
  const vertical = side === 'bottom';
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
        if (vertical && !(e.target as HTMLElement).closest('[data-sheet-grip]')) return;
        drag.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, on: false };
      },
      onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        const el = content.current;
        if (!d || !el) return;
        const dx = vertical ? e.clientY - d.y : e.clientX - d.x;
        if (!d.on) {
          // A vertical gesture is a scroll; give it back.
          const cross = vertical ? e.clientX - d.x : e.clientY - d.y;
          if (Math.abs(cross) > 8 && Math.abs(cross) > Math.abs(dx)) {
            drag.current = null;
            return;
          }
          if (Math.abs(dx) < 8) return;
          d.on = true;
          el.setPointerCapture(e.pointerId);
        }
        d.dx = vertical || dir > 0 ? Math.max(0, dx) : Math.min(0, dx);
        if (prefersReducedMotion()) return;
        el.style.transform = vertical ? `translateY(${d.dx}px)` : `translateX(${d.dx}px)`;
        if (overlay.current) {
          overlay.current.style.opacity = String(
            1 - Math.abs(d.dx) / (vertical ? el.offsetHeight : el.offsetWidth),
          );
        }
      },
      onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        const el = content.current;
        drag.current = null;
        if (!d?.on || !el) return;
        const speed = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t);
        if (Math.abs(d.dx) > (vertical ? el.offsetHeight : el.offsetWidth) * 0.4 || speed > 0.5)
          close?.();
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
  hideClose,
  header,
  footer,
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
          'fixed z-50 flex touch-pan-y flex-col border-border bg-surface-raised shadow-elevation-3',
          side === 'bottom'
            ? 'wl-sheet-bottom inset-x-0 bottom-0 max-h-[88dvh] rounded-t-xl border-t pb-[env(safe-area-inset-bottom)]'
            : 'inset-y-0 w-72 max-w-[calc(100%-1rem)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
          side === 'left' && 'wl-sheet-left left-0 border-r pl-[env(safe-area-inset-left)]',
          side === 'right' &&
            'wl-sheet-right right-0 border-l pr-[env(safe-area-inset-right)] max-sm:w-[calc(100%-1rem)] sm:w-96',
          className,
        )}
        {...props}
      >
        <div
          data-sheet-grip=""
          className="flex min-h-14 items-center justify-between gap-2 border-b border-border px-4 py-2"
        >
          {header}
          <DialogPrimitive.Title className={cn(OVERLAY_TITLE, (hideTitle || header) && 'sr-only')}>
            {title}
          </DialogPrimitive.Title>
          {hideClose ? null : (
            <DialogPrimitive.Close
              aria-label="Close"
              className="relative ml-auto inline-flex size-8 items-center justify-center rounded-md text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong pointer-coarse:size-11"
            >
              <X aria-hidden className="size-4" />
            </DialogPrimitive.Close>
          )}
        </div>
        <SheetBody>{children}</SheetBody>
        {footer ? (
          <div className="grid shrink-0 gap-2 border-t border-border bg-surface-raised p-4">
            {footer}
          </div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** The scroll body: keyboard-focusable only while it overflows, so a keyboard can scroll it. */
function SheetBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={overflows ? 0 : undefined}
      className="min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
    >
      {children}
    </div>
  );
}
