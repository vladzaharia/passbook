import * as DialogPrimitive from '@radix-ui/react-dialog';
import { type ComponentProps, useLayoutEffect, useRef } from 'react';
import { cn } from '../lib/cn.ts';
import { installInputModality } from '../lib/input-modality.ts';

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

/**
 * Onclose auto-focus handler: returns focus to the opener when Radix has no trigger to use. An
 * opener inside an overlay that is closing too (a discard confirm over a dirty dialog) is skipped,
 * so that overlay's own opener takes focus. Focus the page already moved on to (a refused save
 * focusing its field) is left alone.
 */
export function restoreOpener(opener: { current: HTMLElement | null } | null) {
  return (e: Event) => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !active.closest('[role="dialog"], [role="alertdialog"]')
    ) {
      e.preventDefault();
      return;
    }
    const el = opener?.current;
    if (el?.isConnected && !el.closest('[role="dialog"][data-state="closed"]')) {
      e.preventDefault();
      el.focus();
    }
  };
}

/** The scrim behind every dialog, sheet and bottom sheet (menus use the same colour in CSS). */
const OVERLAY = 'wl-overlay fixed inset-0 z-40 bg-black/60';

export function DialogOverlay({
  className,
  onMouseDown,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(OVERLAY, className)}
      // A press on the scrim keeps focus where it was: a dirty dialog asks first, and Keep
      // editing returns the user to their field rather than to nothing.
      onMouseDown={(e) => {
        onMouseDown?.(e);
        e.preventDefault();
      }}
      {...props}
    />
  );
}

/** One title for every overlay: dialogs, confirms, sheets and drawers (16 px, semibold). */
export const OVERLAY_TITLE = 'text-base font-semibold text-fg-strong';

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
