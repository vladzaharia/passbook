import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRouter } from '@tanstack/react-router';
import { LogIn } from 'lucide-react';
import { useState } from 'react';
import { sessionEndedHref } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { Button } from './button.tsx';
import {
  DIALOG_ACTIONS,
  DIALOG_PANEL,
  DialogOverlay,
  focusInitial,
  OVERLAY_TITLE,
} from './overlay.tsx';

/**
 * Shown once when a request comes back 401 (lib/api.ts, ui/session-ended.tsx). It cannot be
 * dismissed: nothing on the page works until the user signs in again. Sign in reloads into /login, past any unsaved-changes
 * guard (the edits cannot be saved anyway), and comes back to this page.
 */
export function SessionEndedDialog() {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        {/* Above every dialog or sheet: nothing under it works any more. */}
        <DialogOverlay className="z-[60]" />
        <DialogPrimitive.Content
          role="alertdialog"
          onOpenAutoFocus={focusInitial}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn(
            DIALOG_PANEL,
            'z-[70] p-5 outline-none sm:max-w-sm max-sm:pb-[max(1.25rem,env(safe-area-inset-bottom))]',
          )}
        >
          <DialogPrimitive.Title className={OVERLAY_TITLE}>
            Your session ended
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-fg-muted">
            Sign in again.
          </DialogPrimitive.Description>
          <div className={cn(DIALOG_ACTIONS, 'mt-5')}>
            <Button
              loading={leaving}
              iconStart={<LogIn aria-hidden />}
              onClick={() => {
                setLeaving(true);
                const { pathname, search } = window.location;
                void router.navigate({
                  href: sessionEndedHref(`${pathname}${search}`),
                  reloadDocument: true,
                  ignoreBlocker: true,
                });
              }}
            >
              Sign in
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
