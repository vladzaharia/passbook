import { useState } from 'react';
import type { SaveWalletCredential, WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import { Button, Dialog, DialogContent, toast } from '@/web/ui/index.ts';
import { PROVIDER_NAME, safeError } from './copy.ts';
import { CREDENTIAL_FORM_ID, WalletCredentialFields } from './credential-fields.tsx';

/** Create (revision 0) or rotate: the caller binds the scope and the revision. */
export function CredentialDialog({
  provider,
  modeLabel,
  revision,
  rotating,
  open,
  onOpenChange,
  save,
}: {
  provider: WalletProvider;
  modeLabel: string;
  revision: number;
  rotating: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  save: (body: SaveWalletCredential) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function onSave(body: SaveWalletCredential) {
    setBusy(true);
    setError('');
    try {
      await save(body);
      toast.success(rotating ? 'Credentials rotated' : 'Credentials saved');
      onOpenChange(false);
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={`${rotating ? 'Rotate' : 'Add'} ${PROVIDER_NAME[provider]} credentials · ${modeLabel}`}
        size="lg"
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form={CREDENTIAL_FORM_ID} loading={busy}>
              {rotating ? 'Rotate' : 'Save'}
            </Button>
          </>
        }
      >
        <WalletCredentialFields
          provider={provider}
          revision={revision}
          rotating={rotating}
          busy={busy}
          onSave={onSave}
        />
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
