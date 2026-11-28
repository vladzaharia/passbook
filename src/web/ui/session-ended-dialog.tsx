import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { sessionEndedHref } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { SignedOutCard } from './hosted-card.tsx';
import { DIALOG_PANEL, DialogOverlay, focusInitial } from './overlay.tsx';

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
            'z-[70] overflow-hidden outline-none sm:max-w-sm max-sm:pb-[env(safe-area-inset-bottom)]',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Signed out</DialogPrimitive.Title>
          <SignedOutCard
            leaving={leaving}
            onSignIn={() => {
              setLeaving(true);
              const { pathname, search } = window.location;
              void router.navigate({
                href: sessionEndedHref(`${pathname}${search}`),
                reloadDocument: true,
                ignoreBlocker: true,
              });
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
