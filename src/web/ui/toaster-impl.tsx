import { CircleCheck, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { Toaster as Sonner, toast as sonner } from 'sonner';
import { errorMessage } from '../lib/errors.ts';
import { BELOW_LG, useMediaQuery } from '../lib/media.ts';
import { isStepUp } from '../lib/step-up.ts';
import { useTheme } from '../lib/theme.tsx';
import { BuddyFace } from './art/face.tsx';
import { useBuddyOnScreen } from './art/presence.ts';
import { toasterReady } from './toaster-queue.ts';

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

const BOTTOM = 'calc(max(var(--wl-bottom-bar, 0px), env(safe-area-inset-bottom)) + 1rem)';
/** Below the sticky top bar (3.5rem), clear of the notch. */
const TOP = 'calc(env(safe-area-inset-top, 0px) + 4rem)';
const LEFT = 'max(1rem, env(safe-area-inset-left))';
const RIGHT = 'max(1rem, env(safe-area-inset-right))';

/**
 * `belowTopBar`: the admin and portal shells. Under 1024 px the page is one column, so a bottom
 * toast lands on the form being used; it sits under the top bar instead. From 1024 px it is
 * bottom right, above the fixed SaveBar or SelectionBar (--wl-bottom-bar, bottom-bar.ts), else
 * the safe area. The scanner screens keep the bottom.
 */
export function ToasterImpl({ belowTopBar = false }: { belowTopBar?: boolean }) {
  const { resolved } = useTheme();
  useEffect(() => {
    toasterReady(toastImpl);
  }, []);
  const narrow = useMediaQuery(BELOW_LG);
  const top = belowTopBar && narrow;
  return (
    <Sonner
      theme={resolved}
      position={top ? 'top-center' : 'bottom-right'}
      offset={top ? { top: TOP, left: LEFT, right: RIGHT } : { bottom: BOTTOM, right: RIGHT }}
      mobileOffset={
        top ? { top: TOP, left: LEFT, right: RIGHT } : { bottom: BOTTOM, left: LEFT, right: RIGHT }
      }
      closeButton
      icons={{
        success: <SuccessMark />,
        error: <XCircle aria-hidden className="size-4 text-danger" />,
      }}
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
          closeButton:
            '!left-auto !right-2 !top-2 !size-7 pointer-coarse:!size-11 !transform-none !rounded-md !border-0 !bg-transparent !text-fg-muted hover:!bg-state-hover-tint hover:!text-fg-strong [&>svg]:size-4',
        },
      }}
    />
  );
}

/** Undo stays a little longer than a plain confirmation: time to read and reach the button. */
const UNDO_MS = 8000;

export const toastImpl = {
  success: (message: string) => sonner.success(message, { duration: 4000 }),
  /** A holder emailed: the buddy posts its pass like a letter. */
  sent: (message: string) =>
    sonner.success(message, { duration: 4000, icon: <SuccessMark scene="post" /> }),
  /** `id` lets the page that shows the outcome take the toast down. */
  info: (message: string, id?: string) => sonner.info(message, { duration: 4000, id }),
  warning: (message: string) => sonner.warning(message, { duration: 6000 }),
  /**
   * Errors stay until dismissed. `title` names what failed, "Could not {verb}" ("Could not save");
   * the line under it is the error's own sentence (errorMessage). A string is that sentence.
   */
  error: (error: unknown, title: string, action?: { label: string; onClick: () => void }) =>
    // A step-up has its own dialog: one message, not two.
    isStepUp(error)
      ? undefined
      : sonner.error(title, { description: errorMessage(error), duration: Infinity, action }),
  /** A success with one follow-up ("View run"). */
  action: (message: string, action: { label: string; onClick: () => void }) =>
    sonner.success(message, { duration: UNDO_MS, action }),
  /**
   * A reversible change with Undo. `onUndo` may return a promise; its failure becomes an error
   * toast, so callers need no catch of their own.
   */
  undo: (message: string, onUndo: () => unknown, id?: string) =>
    sonner.success(message, {
      id,
      duration: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          Promise.resolve()
            .then(onUndo)
            .catch((error: unknown) => toastImpl.error(error, 'Could not undo'));
        },
      },
    }),
  /** Takes a toast down early (its offer no longer applies). No id, no-op. */
  dismiss: (id: string | number | undefined) => {
    if (id !== undefined) sonner.dismiss(id);
  },
};
