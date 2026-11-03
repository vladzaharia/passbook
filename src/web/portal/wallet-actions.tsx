import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, MoreHorizontal, QrCode as QrIcon, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { addLine, showsAddQr } from '@/shared/device.ts';
import { copyText } from '../lib/clipboard.ts';
import { cn } from '../lib/cn.ts';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  toast,
} from '../ui/index.ts';
import { myPassesKey, removePass } from './api.ts';
import { browserDevice } from './device.ts';
import { HolderQr } from './holder-qr.tsx';

/** `/p/:token/pass.pkpass` -> `/p/:token`. The list contract has no public URL field. */
export function publicUrlOf(downloadUrl: string, origin = window.location.origin): string | null {
  const m = /^(.*\/p\/[^/?#]+)\/pass\.pkpass(?:[?#].*)?$/.exec(downloadUrl);
  if (!m?.[1]) return null;
  return new URL(m[1], origin).toString();
}

/** Apple's rule for pages with the badge: say how to add where this browser cannot. */
export function AddLine({ className }: { className?: string }) {
  const line = addLine(browserDevice());
  return line ? <p className={cn('text-sm text-fg-muted', className)}>{line}</p> : null;
}

export function QrDialog({
  passTitle,
  url,
  open,
  setOpen,
}: {
  passTitle: string;
  url: string;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={HOLDER_COPY.scanQr} description={passTitle} size="sm">
        <div className="flex justify-center">
          {open ? <HolderQr value={url} label={HOLDER_COPY.qrAlt(passTitle)} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Show QR" beside the badge on a tile, where this is not the phone (shared/device.ts). */
export function ShowQrButton({ passTitle, url }: { passTitle: string; url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="badge"
        iconStart={<QrIcon aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Show QR
      </Button>
      <QrDialog passTitle={passTitle} url={url} open={open} setOpen={setOpen} />
    </>
  );
}

function useRemovePass(passId: string, onRemoved?: () => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => removePass(passId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: myPassesKey, exact: true });
      toast.success('Removed from your passes');
      onRemoved?.();
    },
  });
}

export interface PassMenuProps {
  passId: string;
  passTitle: string;
  /** The public page: Show QR on a tile; on the detail page Copy link and Open public page. */
  publicUrl: string | null;
  /** Detail page: a labelled "More" with the link items (its QR is on the page). Tiles: an icon. */
  page?: boolean;
  onRemoved?: () => void;
}

/** More beside the badge: Show QR (tiles), Copy link and Open public page (detail), then Remove. */
export function PassMoreMenu({
  passId,
  passTitle,
  publicUrl,
  page = false,
  onRemoved,
}: PassMenuProps) {
  const [qrOpen, setQrOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const mutation = useRemovePass(passId, onRemoved);
  const qr = !page && publicUrl && showsAddQr(browserDevice().device);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {page ? (
            <Button
              variant="outline"
              size="badge"
              className="max-sm:px-3"
              iconStart={<MoreHorizontal aria-hidden />}
            >
              <span className="max-sm:sr-only">More</span>
            </Button>
          ) : (
            <IconButton
              label="More actions"
              variant="outline"
              size="badge"
              icon={<MoreHorizontal aria-hidden />}
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {qr ? (
            <DropdownMenuItem onSelect={() => setQrOpen(true)}>
              <QrIcon aria-hidden /> Show QR
            </DropdownMenuItem>
          ) : null}
          {page && publicUrl ? (
            <>
              <DropdownMenuItem onSelect={() => void copyText(publicUrl, 'link')}>
                <Copy aria-hidden /> Copy link
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden /> Open public page
                </a>
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem destructive onSelect={() => setRemoveOpen(true)}>
            <Trash2 aria-hidden /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {qr ? (
        <QrDialog passTitle={passTitle} url={publicUrl} open={qrOpen} setOpen={setQrOpen} />
      ) : null}
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove from my passes?"
        description={`${passTitle} will not come back unless an admin reassigns it.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => mutation.mutateAsync()}
      />
    </>
  );
}
