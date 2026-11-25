import { useState } from 'react';
import type { PlatformWalletEnrolment } from '@/shared/contracts/wallet-providers.ts';
import { UserMessageError } from '@/web/lib/errors.ts';
import { FormDialog, FormField, Textarea, toast, useFormErrors } from '@/web/ui/index.ts';
import { PROVIDER_NAME, safeError } from './copy.ts';
import { useWalletActions } from './queries.ts';

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
  const [busy, setBusy] = useState(false);
  const check = useFormErrors(reason.trim() ? {} : { reason: 'Required.' });

  return (
    <FormDialog
      open={enrolment !== undefined}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={`Hold ${enrolment ? `${enrolment.orgName} · ${PROVIDER_NAME[enrolment.provider]}` : ''}?`}
      description="Turns it Off. The organization cannot turn it on until you release it."
      dirty={reason !== ''}
      check={check}
      submitLabel="Hold"
      busy={busy}
      onSubmit={async () => {
        if (!enrolment) return;
        setBusy(true);
        try {
          const { status } = await actions.hold(
            enrolment.orgId,
            enrolment.mode,
            enrolment.provider,
            reason.trim(),
          );
          toast.success(status === 'queued' ? 'Hold queued' : 'Held');
          onClose();
        } catch (cause) {
          throw new UserMessageError(safeError(cause));
        } finally {
          setBusy(false);
        }
      }}
      onClose={() => setReason('')}
    >
      <FormField
        label="Reason"
        help="The organization sees this."
        error={check.errors.reason}
        required
      >
        {(props) => (
          <Textarea
            {...props}
            data-autofocus
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </FormField>
    </FormDialog>
  );
}
