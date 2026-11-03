import { useRef } from 'react';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { Button, CopyButton, Dialog, DialogContent, toast } from '../../ui/index.ts';
import { usePassActions } from './api.ts';
import { absoluteUrl, newKey } from './format.ts';
import type { PassLinks } from './pass-actions.tsx';

/** After a rotate: the new public link, with Copy and an email to the holder. */
export function RotatedLinkDialog({
  links,
  holderEmail,
  passId,
  onClose,
}: {
  links: PassLinks | null;
  holderEmail: string | null;
  passId: string;
  onClose: () => void;
}) {
  const actions = usePassActions(passId);
  const key = useRef(newKey());
  const url = links ? absoluteUrl(links.publicUrl) : '';
  return (
    <Dialog open={links !== null} onOpenChange={(open) => !open && onClose()}>
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
                loading={actions.resendEmail.isPending}
                onClick={() =>
                  actions.resendEmail
                    .mutateAsync({ key: key.current })
                    .then(() => {
                      key.current = newKey();
                      toast.sent(`New link emailed to ${holderEmail}`);
                      onClose();
                    })
                    .catch((error: unknown) => toast.error(error, 'Could not send'))
                }
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
