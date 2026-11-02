import { useEffect, useState } from 'react';
import { Toaster as Sonner, toast as sonner } from 'sonner';
import { errorMessage } from '../lib/errors.ts';
import { PHONE, useMediaQuery } from '../lib/media.ts';
import { useTheme } from '../lib/theme.tsx';

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
      toastOptions={{
        classNames: {
          toast:
            '!bg-surface-overlay !text-fg-strong !border !border-border !rounded-lg !shadow-elevation-3',
          description: '!text-fg-muted',
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
