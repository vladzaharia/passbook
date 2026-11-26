import { useState } from 'react';
import type { PlatformWalletEnrolment } from '@/shared/contracts/wallet-providers.ts';
import { holdConfirm } from '@/web/lib/confirms-wallet.ts';
import { Button, Dialog, DialogContent, FormField, Textarea, toast } from '@/web/ui/index.ts';
import { PROVIDER_NAME, safeError } from './copy.ts';
import { useWalletActions } from './queries.ts';

const FORM_ID = 'hold-enrolment';

/** A platform hold turns the organization's account Off until it is released. */
export function HoldDialog({
  enrolment,
  onClose,
}: {
  enrolment: Pick<PlatformWalletEnrolment, 'orgId' | 'orgName' | 'mode' | 'provider'> | undefined;
  onClose: () => void;
}) {
  const actions = useWalletActions();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => {
    setReason('');
    setError('');
    onClose();
  };
  async function submit() {
    if (!enrolment) return;
    if (!reason.trim()) {
      setError('Required.');
      return;
    }
    setBusy(true);
    try {
      const { status } = await actions.hold(
        enrolment.orgId,
        enrolment.mode,
        enrolment.provider,
        reason.trim(),
      );
      toast.success(status === 'queued' ? 'Hold queued' : 'Held');
      close();
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }
  const copy = holdConfirm(
    enrolment ? `${enrolment.orgName} · ${PROVIDER_NAME[enrolment.provider]}` : '',
  );
  return (
    <Dialog open={enrolment !== undefined} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent
        title={copy.title}
        description={copy.description}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} variant="danger" loading={busy}>
              {copy.confirmLabel}
            </Button>
          </>
        }
      >
        <form
          id={FORM_ID}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormField
            label="Reason"
            help="The organization sees this."
            error={error || undefined}
            required
          >
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError('');
                }}
              />
            )}
          </FormField>
        </form>
      </DialogContent>
    </Dialog>
  );
}
