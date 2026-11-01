import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, QrCode as QrIcon, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
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
import { QrCode } from './qr-code.tsx';

/** `/p/:token/pass.pkpass` -> `/p/:token`. The list contract has no public URL field. */
export function publicUrlOf(downloadUrl: string, origin = window.location.origin): string | null {
  const m = /^(.*\/p\/[^/?#]+)\/pass\.pkpass(?:[?#].*)?$/.exec(downloadUrl);
  if (!m?.[1]) return null;
  return new URL(m[1], origin).toString();
}

export function AddToWalletButton({
  downloadUrl,
  size = 'md',
  onPress,
}: {
  downloadUrl: string;
  size?: 'sm' | 'md' | 'lg';
  /** Runs as the download starts (the card dips towards the button). */
  onPress?: () => void;
}) {
  return (
    <Button asChild size={size} iconStart={<Wallet aria-hidden />}>
      <a href={downloadUrl} onClick={onPress}>
        Add to Apple Wallet
      </a>
    </Button>
  );
}

function QrDialog({
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
      <DialogContent title="Scan with iPhone" description={passTitle} size="sm">
        <div className="flex justify-center">
          {open ? <QrCode value={url} label={`QR code for ${passTitle}`} /> : null}
        </div>
      </DialogContent>
    </Dialog>
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

export function RemovePassButton({
  passId,
  passTitle,
  onRemoved,
  size = 'sm',
}: {
  passId: string;
  passTitle: string;
  onRemoved?: () => void;
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const mutation = useRemovePass(passId, onRemoved);
  return (
    <>
      <Button
        variant="ghost"
        size={size}
        iconStart={<Trash2 aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Remove
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remove from my passes?"
        description={`${passTitle} will not come back unless an admin reassigns it.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => mutation.mutateAsync()}
      />
    </>
  );
}

/** Secondary tile actions: Show QR (when a public link exists) and Remove. */
export function PassMoreMenu({
  passId,
  passTitle,
  qrUrl,
}: {
  passId: string;
  passTitle: string;
  qrUrl: string | null;
}) {
  const [qrOpen, setQrOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const mutation = useRemovePass(passId);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label="More actions"
            icon={<MoreHorizontal aria-hidden />}
            variant="ghost"
            size="sm"
            className="ml-auto"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {qrUrl ? (
            <DropdownMenuItem onSelect={() => setQrOpen(true)}>
              <QrIcon aria-hidden /> Show QR
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem destructive onSelect={() => setRemoveOpen(true)}>
            <Trash2 aria-hidden /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {qrUrl ? (
        <QrDialog passTitle={passTitle} url={qrUrl} open={qrOpen} setOpen={setQrOpen} />
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
