import type { SaveWalletCredential, WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import { UserMessageError } from '@/web/lib/errors.ts';
import { Callout, FormDialog, toast } from '@/web/ui/index.ts';
import { PROVIDER_NAME, safeError } from './copy.ts';
import { useCredentialForm, WalletCredentialFields } from './credential-fields.tsx';

/**
 * Create (revision 0) or rotate: the caller binds the scope and the revision. No dirty guard:
 * the form is uncontrolled so secrets stay out of React state, and a closed dialog drops them.
 */
export function CredentialDialog({
  provider,
  modeLabel,
  revision,
  rotating,
  open,
  onOpenChange,
  save,
  notice,
}: {
  provider: WalletProvider;
  modeLabel: string;
  revision: number;
  rotating: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  save: (body: SaveWalletCredential) => Promise<unknown>;
  /** Why the wallet is dark ("Google isn't released yet."): credentials can still be saved. */
  notice?: string | null | undefined;
}) {
  const form = useCredentialForm(provider, revision);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${rotating ? 'Rotate' : 'Add'} ${PROVIDER_NAME[provider]} credentials · ${modeLabel}`}
      description={
        rotating
          ? 'The issuer, or partner and cards, stay the same: enter every card again.'
          : undefined
      }
      size="lg"
      notice={notice ? <Callout tone="info">{notice}</Callout> : undefined}
      submitLabel={rotating ? 'Rotate' : 'Save'}
      onSubmit={async () => {
        const request = form.read();
        if (!request) throw new UserMessageError('Check the highlighted fields.');
        try {
          await save(request);
        } catch (cause) {
          throw new UserMessageError(safeError(cause));
        }
        toast.success(rotating ? 'Credentials rotated' : 'Credentials saved');
        onOpenChange(false);
      }}
      onClose={form.reset}
    >
      <WalletCredentialFields provider={provider} form={form} />
    </FormDialog>
  );
}
