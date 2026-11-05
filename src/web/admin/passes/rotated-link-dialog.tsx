import { useRef, useState } from 'react';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { Button, ConfirmDialog, CopyButton, Dialog, DialogContent, toast } from '../../ui/index.ts';
import { absoluteUrl, newKey } from './format.ts';

/** After a rotate: the new public link, with Copy and an email to the holder. */
export function RotatedLinkDialog({
  url: link,
  holderEmail,
  sendEmail,
  onClose,
}: {
  /** The new link; null while closed. */
  url: string | null;
  holderEmail: string | null;
  /** Emails the new link; the key makes a retry idempotent. */
  sendEmail: (key: string) => Promise<unknown>;
  onClose: () => void;
}) {
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
                  setSending(true);
                  sendEmail(key.current)
                    .then(() => {
                      key.current = newKey();
                      toast.sent(`New link emailed to ${holderEmail}`);
                      onClose();
                    })
                    .catch((error: unknown) => toast.error(error, 'Could not send'))
                    .finally(() => setSending(false));
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
  /** Rotates and returns the new public link. */
  rotate: () => Promise<string>;
  holderEmail: string | null;
  sendEmail: (key: string) => Promise<unknown>;
}) {
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
        onConfirm={async () => setUrl(await rotate())}
      />
      <RotatedLinkDialog
        url={url}
        holderEmail={holderEmail}
        sendEmail={sendEmail}
        onClose={() => setUrl(null)}
      />
    </>
  );
}
