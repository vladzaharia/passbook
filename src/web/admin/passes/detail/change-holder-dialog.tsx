import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { EMAIL_INVALID_MESSAGE, strictEmail } from '@/shared/email.ts';
import { sessionQuery } from '../../../lib/session.ts';
import {
  CheckboxField,
  FormDialog,
  FormField,
  Input,
  toast,
  useFormErrors,
} from '../../../ui/index.ts';
import { usePassActions } from '../api.ts';
import { reportEmailError } from '../email-outcome.ts';
import { newKey } from '../format.ts';

/** Change the holder: assign or reassign, and email the pass to the new address (on by default). */
export function ChangeHolderDialog({
  pass,
  open,
  onOpenChange,
}: {
  pass: PassDetailDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = usePassActions(pass.id);
  const client = useQueryClient();
  const [email, setEmail] = useState(pass.holderEmail ?? '');
  const [send, setSend] = useState(true);
  const owned = pass.holderState === 'owned';
  const trimmed = email.trim();
  const same = trimmed.toLowerCase() === (pass.holderEmail ?? '').toLowerCase();
  const check = useFormErrors({
    ...(strictEmail(trimmed) === null ? { email: EMAIL_INVALID_MESSAGE } : {}),
    ...(trimmed && same ? { email: 'Enter a different email.' } : {}),
  });

  async function save() {
    const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!before?.authenticated) return;
    const userId = before.user.id;
    const stillCurrent = () => {
      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      return current?.authenticated === true && current.user.id === userId;
    };
    let holder: Awaited<ReturnType<typeof actions.assign.mutateAsync>>;
    try {
      holder = owned
        ? await actions.reassign.mutateAsync(trimmed)
        : await actions.assign.mutateAsync(trimmed);
    } catch (cause) {
      // A different person's session never sees this one's refusal.
      if (stillCurrent()) throw cause;
      return;
    }
    if (!stillCurrent()) return;
    if (holder.transfer?.state === 'pending') {
      toast.info(
        'Holder transfer pending. Existing wallet credentials must be retired before the pass is available; no email was sent.',
      );
      onOpenChange(false);
      return;
    }
    if (send) {
      try {
        await actions.resendEmail.mutateAsync({ to: trimmed, key: newKey() });
        if (!stillCurrent()) return;
        toast.info(`Holder changed; email queued to ${trimmed}`);
      } catch (error) {
        if (!stillCurrent()) return;
        reportEmailError(error, 'Holder changed. ');
      }
    } else toast.success('Holder changed');
    if (stillCurrent()) onOpenChange(false);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change holder"
      description={
        owned
          ? 'The current owner loses access while the existing credentials are retired.'
          : undefined
      }
      dirty={trimmed !== (pass.holderEmail ?? '')}
      check={check}
      onSubmit={save}
      submitLabel={send ? 'Change and send' : 'Change holder'}
      onClose={() => {
        setEmail(pass.holderEmail ?? '');
        setSend(true);
      }}
    >
      {({ errors: server }) => (
        <>
          <FormField label="Email" error={check.errors.email ?? server.email}>
            {(c) => (
              <Input
                {...c}
                name="email"
                data-autofocus
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </FormField>
          <CheckboxField
            label={strictEmail(trimmed) ? `Email the pass to ${trimmed}` : 'Email the pass'}
            checked={send}
            onCheckedChange={(c) => setSend(c === true)}
          />
          {send ? (
            <p className="text-sm text-fg-muted">
              Email is sent only if the transfer completes immediately. Otherwise, send it after the
              transfer finishes.
            </p>
          ) : null}
        </>
      )}
    </FormDialog>
  );
}
