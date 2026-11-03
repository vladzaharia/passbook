import { CircleCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Toaster as Sonner, toast as sonner } from 'sonner';
import { errorMessage } from '../lib/errors.ts';
import { PHONE, useMediaQuery } from '../lib/media.ts';
import { useTheme } from '../lib/theme.tsx';
import { BuddyFace } from './art/face.tsx';
import { useBuddyOnScreen } from './art/presence.ts';
import { TOUCH_HIT } from './button.tsx';

/** True while a modal dialog, sheet or menu holds the page (Radix locks body scroll). */
function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const body = document.body;
    const read = () => setOpen(body.hasAttribute('data-scroll-locked'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(body, { attributes: true, attributeFilter: ['data-scroll-locked'] });
    return () => observer.disconnect();
  }, []);
  return open;
}

/**
 * Success wears the buddy in miniature (it pops in and winks once, or posts a letter). A view
 * shows one buddy at most: while a page buddy is mounted, the toast takes a check instead.
 */
function SuccessMark({ scene }: { scene?: 'post' }) {
  return useBuddyOnScreen() ? (
    <CircleCheck aria-hidden className="size-4 text-success" />
  ) : (
    <BuddyFace scene={scene} className="h-5 w-6" />
  );
}

export function Toaster() {
  const { resolved } = useTheme();
  // Phone sheets rise from the bottom: toasts move to the top so they never cover sheet actions.
  const phone = useMediaQuery(PHONE);
  const overlay = useOverlayOpen();
  return (
    <Sonner
      theme={resolved}
      position={phone && overlay ? 'top-center' : 'bottom-right'}
      // Keep toasts clear of the fixed SaveBar; an error toast sits there until dismissed and
      // would otherwise cover Save/Discard.
      offset={{
        bottom: 'calc(5rem + env(safe-area-inset-bottom))',
        right: 'max(1rem, env(safe-area-inset-right))',
      }}
      mobileOffset={{
        top: 'calc(0.75rem + env(safe-area-inset-top))',
        bottom: 'calc(5rem + env(safe-area-inset-bottom))',
        left: 'max(1rem, env(safe-area-inset-left))',
        right: 'max(1rem, env(safe-area-inset-right))',
      }}
      closeButton
      icons={{ success: <SuccessMark /> }}
      toastOptions={{
        // Close sits top right inside the box, like a dialog's; the text keeps clear of it.
        classNames: {
          toast:
            '!bg-surface-overlay !text-fg-strong !border !border-border !rounded-lg !shadow-elevation-3 !text-sm !pr-11',
          title: '!font-medium',
          description: '!text-fg-muted',
          // A Button md: 36 px, 44 on touch.
          actionButton:
            '!bg-accent !text-accent-on !h-9 pointer-coarse:!h-11 !px-4 !text-sm !rounded-md',
          closeButton: `!left-auto !right-2 !top-2 !size-7 !transform-none !rounded-md !border-0 !bg-transparent !text-fg-muted hover:!bg-state-hover-tint hover:!text-fg-strong [&>svg]:size-4 ${TOUCH_HIT}`,
        },
      }}
    />
  );
}

/** Undo stays a little longer than a plain confirmation: time to read and reach the button. */
const UNDO_MS = 8000;

export const toast = {
  success: (message: string) => sonner.success(message, { duration: 4000 }),
  /** A holder emailed: the buddy posts its pass like a letter. */
  sent: (message: string) =>
    sonner.success(message, { duration: 4000, icon: <SuccessMark scene="post" /> }),
  info: (message: string) => sonner.info(message, { duration: 4000 }),
  /**
   * Errors stay until dismissed. `title` names what failed, "Could not {verb}" ("Could not save");
   * the line under it is the error's own sentence (errorMessage). A string is that sentence.
   */
  error: (error: unknown, title: string) =>
    sonner.error(title, { description: errorMessage(error), duration: Infinity }),
  /** A success with one follow-up ("View run"). */
  action: (message: string, action: { label: string; onClick: () => void }) =>
    sonner.success(message, { duration: UNDO_MS, action }),
  /**
   * A reversible change with Undo. `onUndo` may return a promise; its failure becomes an error
   * toast, so callers need no catch of their own.
   */
  undo: (message: string, onUndo: () => unknown) =>
    sonner.success(message, {
      duration: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          Promise.resolve()
            .then(onUndo)
            .catch((error: unknown) => toast.error(error, 'Could not undo'));
        },
      },
    }),
  /** Takes a toast down early (its offer no longer applies). No id, no-op. */
  dismiss: (id: string | number | undefined) => {
    if (id !== undefined) sonner.dismiss(id);
  },
};
