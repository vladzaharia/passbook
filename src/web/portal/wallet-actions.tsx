import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QrCode as QrIcon, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Button, ConfirmDialog, Dialog, DialogContent, toast } from '../ui/index.ts';
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
}: {
  downloadUrl: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <Button asChild size={size} iconStart={<Wallet aria-hidden />}>
      <a href={downloadUrl}>Add to Apple Wallet</a>
    </Button>
  );
}

export function QrButton({ passTitle, url }: { passTitle: string; url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        iconStart={<QrIcon aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Show QR
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Scan with iPhone" description={passTitle} size="sm">
          <div className="flex justify-center">
            {open ? <QrCode value={url} label={`QR code for ${passTitle}`} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
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
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: () => removePass(passId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: myPassesKey, exact: true });
      toast.success('Removed from your passes');
      onRemoved?.();
    },
  });
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
