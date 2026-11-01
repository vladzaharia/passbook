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
  /** sm 384 confirms, md 512 forms (default), lg 768 uploads and editors. */
  size?: 'sm' | 'md' | 'lg';
  /** Destructive confirms have no X. */
  closeButton?: boolean;
}

const SIZES = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-3xl' } as const;

/**
 * Shared panel classes: centred at 640 and up; below it a bottom sheet (full width, rounded top,
 * safe-area padding) that slides up (kit-motion.css).
 */
export const DIALOG_PANEL = cn(
  'fixed z-50 flex flex-col border border-border bg-surface-overlay shadow-[var(--wl-edge),var(--pk-elevation-3)] wl-dialog',
  'sm:top-1/2 sm:left-1/2 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg',
  'max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] max-sm:rounded-t-xl max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom)]',
);

/** Footer actions: right-aligned row; stacked full width on phones with the primary on top. */
export const DIALOG_ACTIONS =
  'flex flex-wrap justify-end gap-2 max-sm:flex-col-reverse max-sm:[&>*]:min-h-11 max-sm:[&>*]:w-full';

/** Focus a [data-autofocus] field, else the dialog itself: never Cancel. */
export function focusInitial(e: Event) {
  const content = e.currentTarget as HTMLElement | null;
  e.preventDefault();
  const target = content?.querySelector<HTMLElement>('[data-autofocus]') ?? content;
  target?.focus({ preventScroll: true });
}

export function DialogContent({
  title,
  description,
  footer,
  hideTitle,
  size = 'md',
  closeButton = true,
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  const opener = useContext(OpenerContext);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        {...(description ? {} : { 'aria-describedby': undefined })}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (!e.defaultPrevented) focusInitial(e);
        }}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          if (!e.defaultPrevented) restoreOpener(opener)(e);
        }}
        className={cn(DIALOG_PANEL, SIZES[size], 'outline-none', className)}
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
              <DialogPrimitive.Description className="mt-1 max-w-[65ch] text-sm text-fg-muted">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          {closeButton ? (
            <DialogPrimitive.Close
              aria-label="Close"
              className="relative -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong pointer-coarse:size-11"
            >
              <X aria-hidden className="size-4" />
            </DialogPrimitive.Close>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className={cn(DIALOG_ACTIONS, 'border-t border-border px-5 py-3')}>{footer}</div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
