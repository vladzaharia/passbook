import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { sessionQuery } from '../../lib/session.ts';
import { Button, ConfirmDialog, CopyButton, Dialog, DialogContent, toast } from '../../ui/index.ts';
import { reportEmailError } from './email-outcome.ts';
import { absoluteUrl, newKey } from './format.ts';

/** After a rotate: the new public link, with Copy and an email to the holder. */
export function RotatedLinkDialog({
  url: link,
  holderEmail,
  sendEmail,
  mode,
  onClose,
}: {
  /** The new link; null while closed. */
  url: string | null;
  holderEmail: string | null;
  /** Requests an email; the callback may use the supplied key for idempotency. */
  sendEmail: (key: string) => Promise<unknown>;
  /** Test-mode mail is held back after it is processed. */
  mode?: Mode;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [sending, setSending] = useState(false);
  const key = useRef(newKey());
  const url = link ? absoluteUrl(link) : '';
  return (
    <Dialog open={link !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="md"
        title="Link rotated"
        description="The old link no longer works."
        footer={
          <>
            {holderEmail ? (
              <Button
                variant="outline"
                iconStart={<ACTION_ICON.sendEmail aria-hidden />}
                loading={sending}
                onClick={() => {
                  const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
                  if (!before?.authenticated) return;
                  const userId = before.user.id;
                  setSending(true);
                  sendEmail(key.current)
                    .then(() => {
                      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
                      if (!current?.authenticated || current.user.id !== userId) return;
                      key.current = newKey();
                      toast.info(
                        mode === 'test'
                          ? 'Test email queued. Check the Test inbox for capture.'
                          : `Email queued to ${holderEmail}`,
                      );
                      const afterToast = client.getQueryData<SessionResponse>(
                        sessionQuery.queryKey,
                      );
                      if (!afterToast?.authenticated || afterToast.user.id !== userId) return;
                      onClose();
                    })
                    .catch((error: unknown) => {
                      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
                      if (!current?.authenticated || current.user.id !== userId) return;
                      reportEmailError(error);
                    })
                    .finally(() => {
                      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
                      if (current?.authenticated && current.user.id === userId) setSending(false);
                    });
                }}
              >
                Email new link to holder
              </Button>
            ) : null}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-sunken py-1 pr-1 pl-3">
          <ACTION_ICON.rotate aria-hidden className="wl-turn-once size-4 shrink-0 text-accent-fg" />
          <span
            data-autofocus
            tabIndex={-1}
            className="min-w-0 flex-1 truncate font-mono text-xs text-fg outline-none"
          >
            {url}
          </span>
          <CopyButton value={url} label="Copy link" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Rotate a capability link: the confirm, then the new link. One flow for a pass and a bundle, so
 * both warn the same way and both end with the link and the holder email.
 */
export function RotateLink({
  open,
  onOpenChange,
  description,
  rotate,
  holderEmail,
  sendEmail,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
  /** Rotates and returns the new public link. */
  rotate: () => Promise<string>;
  holderEmail: string | null;
  sendEmail: (key: string) => Promise<unknown>;
  mode?: Mode;
}) {
  const client = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  return (
    <>
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Rotate link?"
        description={description}
        confirmLabel="Rotate"
        destructive
        onConfirm={async () => {
          const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
          if (!before?.authenticated) return;
          const userId = before.user.id;
          try {
            const next = await rotate();
            const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
            if (!current?.authenticated || current.user.id !== userId) return;
            setUrl(next);
          } catch (error) {
            const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
            if (current?.authenticated && current.user.id === userId) throw error;
          }
        }}
      />
      <RotatedLinkDialog
        url={url}
        holderEmail={holderEmail}
        sendEmail={sendEmail}
        mode={mode}
        onClose={() => setUrl(null)}
      />
    </>
  );
}
