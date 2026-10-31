import { Toaster as Sonner, toast as sonner } from 'sonner';
import { errorMessage } from '../lib/errors.ts';
import { useTheme } from '../lib/theme.tsx';

export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
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
