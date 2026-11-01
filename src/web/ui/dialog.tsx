import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react';
import { cn } from '../lib/cn.ts';
import { installInputModality } from '../lib/input-modality.ts';

const OpenerContext = createContext<{ current: HTMLElement | null } | null>(null);

/** The element to refocus: a dropdown item resolves to its menu trigger, which outlives the item. */
function openerOf(active: HTMLElement): HTMLElement {
  const labelledBy = active.closest('[role="menu"]')?.getAttribute('aria-labelledby');
  const trigger = labelledBy ? document.getElementById(labelledBy) : null;
  return trigger ?? active;
}

/** Remembers the element focused when a state-controlled overlay opens. */
export function useOpener(open: boolean | undefined) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    installInputModality();
    if (open && document.activeElement instanceof HTMLElement) {
      opener.current = openerOf(document.activeElement);
    }
  }, [open]);
  return opener;
}

/** Onclose auto-focus handler: returns focus to the opener when Radix has no trigger to use. */
export function restoreOpener(opener: { current: HTMLElement | null } | null) {
  return (e: Event) => {
    const el = opener?.current;
    if (el?.isConnected) {
      e.preventDefault();
      el.focus();
    }
  };
}

/** Dialog root. Focus returns to the opener on close, with or without a DialogTrigger. */
export function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  const opener = useOpener(props.open);
  return (
    <OpenerContext.Provider value={opener}>
      <DialogPrimitive.Root {...props} />
    </OpenerContext.Provider>
  );
}
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const OVERLAY = 'wl-overlay fixed inset-0 z-40 bg-black/60';

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn(OVERLAY, className)} {...props} />;
}

export interface DialogContentProps
  extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** Visually hide the title; it stays the accessible name. */
  hideTitle?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

export function DialogContent({
  title,
  description,
  footer,
  hideTitle,
  size = 'md',
  className,
  children,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  const opener = useContext(OpenerContext);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        {...(description ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (!e.defaultPrevented) restoreOpener(opener)(e);
        }}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface-overlay',
          'wl-dialog shadow-[var(--wl-edge),var(--pk-elevation-3)]',
          SIZES[size],
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <DialogPrimitive.Title
              className={cn('text-base font-semibold text-fg-strong', hideTitle && 'sr-only')}
            >
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-sm text-fg-muted">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-state-hover-tint hover:text-fg-strong"
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
