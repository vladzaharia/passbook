import { Toaster as Sonner, toast as sonner } from 'sonner';
import { errorMessage } from '../lib/errors.ts';
import { useTheme } from '../lib/theme.tsx';

export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      // Keep toasts clear of the fixed SaveBar; an error toast sits there until dismissed and
      // would otherwise cover Save/Discard.
      offset={{ bottom: '5rem', right: '1rem' }}
      mobileOffset={{ bottom: '5rem', left: '1rem', right: '1rem' }}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            '!bg-surface-overlay !text-fg-strong !border !border-border !rounded-lg !shadow-elevation-3',
          description: '!text-fg-muted',
          icon: 'wl-check',
          actionButton: '!bg-accent !text-accent-on',
          closeButton: '!bg-surface-overlay !text-fg !border-border',
        },
      }}
    />
  );
}

export const toast = {
  success: (message: string) => sonner.success(message, { duration: 4000 }),
  info: (message: string) => sonner.info(message, { duration: 4000 }),
  /** Errors stay until dismissed. Accepts an ApiError or any value. */
  error: (error: unknown, title = 'Failed') =>
    sonner.error(title, { description: errorMessage(error), duration: Infinity }),
};
