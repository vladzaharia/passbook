import { CircleCheck, XCircle } from 'lucide-react';
import { Toaster as Sonner, toast as sonner } from 'sonner';
import { errorMessage } from '../lib/errors.ts';
import { useTheme } from '../lib/theme.tsx';
import { BuddyFace } from './art/face.tsx';
import { useBuddyOnScreen } from './art/presence.ts';
import { TOUCH_HIT } from './button.tsx';

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

export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      // Above the fixed SaveBar or SelectionBar (--wl-bottom-bar, bottom-bar.ts), else the safe
      // area. Phones keep the bottom with an overlay open: the top would cover a sheet's header.
      offset={{ bottom: BOTTOM, right: 'max(1rem, env(safe-area-inset-right))' }}
      mobileOffset={{
        bottom: BOTTOM,
        left: 'max(1rem, env(safe-area-inset-left))',
        right: 'max(1rem, env(safe-area-inset-right))',
      }}
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
