import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Download,
  ExternalLink,
  MoreHorizontal,
  QrCode as QrIcon,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import {
  AppleWalletBadge,
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
import { canAddToWallet } from './device.ts';
import { QrCode } from './qr-code.tsx';

/** `/p/:token/pass.pkpass` -> `/p/:token`. The list contract has no public URL field. */
export function publicUrlOf(downloadUrl: string, origin = window.location.origin): string | null {
  const m = /^(.*\/p\/[^/?#]+)\/pass\.pkpass(?:[?#].*)?$/.exec(downloadUrl);
  if (!m?.[1]) return null;
  return new URL(m[1], origin).toString();
}

/** Apple's badge (the kit AppleWalletBadge); never a custom button. */
export function AddToWalletButton({
  downloadUrl,
  onPress,
}: {
  downloadUrl: string;
  /** Runs as the download starts (the card dips towards the badge). */
  onPress?: () => void;
}) {
  return <AppleWalletBadge href={downloadUrl} onClick={onPress} />;
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
      <DialogContent title="Scan with your iPhone" description={passTitle} size="sm">
        <div className="flex justify-center">
          {open ? <QrCode value={url} label={`QR code for ${passTitle}`} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Show QR" as a button: the lead action where the device cannot add passes. */
export function ShowQrButton({ passTitle, url }: { passTitle: string; url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" iconStart={<QrIcon aria-hidden />} onClick={() => setOpen(true)}>
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

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied');
  } catch (error) {
    // Clipboard needs a secure context and permission: say so instead of failing silently.
    toast.error(error, 'Could not copy the link');
  }
}

export interface PassMenuProps {
  passId: string;
  passTitle: string;
  /** The public page: Show QR, and on the detail page Copy link and Open public page. */
  publicUrl: string | null;
  /** The .pkpass, offered again once the pass is in a Wallet (it left Add all). */
  addAgainHref?: string | null;
  /** Detail page: a labelled outline "More" with the link items. Tiles: a ghost icon. */
  page?: boolean;
  onRemoved?: () => void;
}

/** More: Show QR, Copy link and Open public page (detail), Add again, then Remove (danger). */
export function PassMoreMenu({
  passId,
  passTitle,
  publicUrl,
  addAgainHref,
  page = false,
  onRemoved,
}: PassMenuProps) {
  const [qrOpen, setQrOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const mutation = useRemovePass(passId, onRemoved);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {page ? (
            <Button
              variant="outline"
              size="lg"
              className="max-sm:px-3"
              iconStart={<MoreHorizontal aria-hidden />}
            >
              <span className="max-sm:sr-only">More</span>
            </Button>
          ) : (
            <IconButton
              label="More actions"
              icon={<MoreHorizontal aria-hidden />}
              className="pointer-coarse:size-11"
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* A QR to scan with an iPhone means nothing on the iPhone itself. */}
          {publicUrl && !canAddToWallet() ? (
            <DropdownMenuItem onSelect={() => setQrOpen(true)}>
              <QrIcon aria-hidden /> Show QR
            </DropdownMenuItem>
          ) : null}
          {page && publicUrl ? (
            <>
              <DropdownMenuItem onSelect={() => void copyLink(publicUrl)}>
                <Copy aria-hidden /> Copy link
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={publicUrl}>
                  <ExternalLink aria-hidden /> Open public page
                </a>
              </DropdownMenuItem>
            </>
          ) : null}
          {addAgainHref ? (
            <DropdownMenuItem asChild>
              <a href={addAgainHref}>
                <Download aria-hidden /> Add again
              </a>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem destructive onSelect={() => setRemoveOpen(true)}>
            <Trash2 aria-hidden /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {publicUrl ? (
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
