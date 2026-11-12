import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pencil } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { EMAIL_INVALID_MESSAGE, strictEmail } from '@/shared/email.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { sessionQuery } from '../../../lib/session.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  Dialog,
  DialogContent,
  EntityAvatar,
  Form,
  FormField,
  Input,
  KeyValue,
  ListRow,
  ListRows,
  StatusPill,
  toast,
  useFormErrors,
} from '../../../ui/index.ts';
import { passKeys, usePassActions, usePassHolder } from '../api.ts';
import { reportEmailError } from '../email-outcome.ts';
import { newKey } from '../format.ts';

/** Change the holder: assign or reassign, and email the pass to the new address (on by default). */
function ChangeHolderDialog({
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
  const formId = useId();
  const [email, setEmail] = useState(pass.holderEmail ?? '');
  const [send, setSend] = useState(true);
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const owned = pass.holderState === 'owned';
  const trimmed = email.trim();
  const valid = strictEmail(trimmed) !== null;
  const same = trimmed.toLowerCase() === (pass.holderEmail ?? '').toLowerCase();
  const check = useFormErrors({ email: valid ? undefined : EMAIL_INVALID_MESSAGE });

  async function save() {
    const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!before?.authenticated) return;
    const userId = before.user.id;
    const stillCurrent = () => {
      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      return current?.authenticated === true && current.user.id === userId;
    };
    setBusy(true);
    setFailed(undefined);
    try {
      const holder = owned
        ? await actions.reassign.mutateAsync(trimmed)
        : await actions.assign.mutateAsync(trimmed);
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
      if (!stillCurrent()) return;
      onOpenChange(false);
    } catch (cause) {
      if (stillCurrent()) setFailed(errorMessage(cause));
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      dirty={trimmed !== (pass.holderEmail ?? '')}
      onOpenChange={(o) => !busy && onOpenChange(o)}
    >
      <DialogContent
        title="Change holder"
        description={
          owned
            ? 'The current owner loses access while the existing credentials are retired.'
            : undefined
        }
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={busy} disabled={!trimmed || same}>
              {send ? 'Change and send' : 'Change holder'}
            </Button>
          </>
        }
      >
        <Form
          id={formId}
          {...check.form}
          onValid={() => void save()}
          className="flex flex-col gap-4"
        >
          <FormField label="Email" error={check.errors.email ?? failed}>
            {(c) => (
              <Input
                {...c}
                data-autofocus
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFailed(undefined);
                }}
              />
            )}
          </FormField>
          <CheckboxField
            label={valid ? `Email the pass to ${trimmed}` : 'Email the pass'}
            checked={send}
            onCheckedChange={(c) => setSend(c === true)}
          />
          {send ? (
            <p className="text-sm text-fg-muted">
              Email is sent only if the transfer completes immediately. Otherwise, send it after the
              transfer finishes.
            </p>
          ) : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** One card: the holder's state and who it is, with Change. Clear lives in the header's More. */
export function HolderTab({ pass, readOnly }: { pass: PassDetailDto; readOnly: boolean }) {
  const actions = usePassActions(pass.id);
  const client = useQueryClient();
  const holder = usePassHolder(pass.id, pass.orgId);
  const wasPending = useRef(false);
  const pending = holder.data?.transfer?.state === 'pending';
  useEffect(() => {
    if (!holder.isSuccess) return;
    if (wasPending.current && !pending)
      void client.invalidateQueries({ queryKey: passKeys.detail(pass.id) });
    wasPending.current = pending;
  }, [client, holder.isSuccess, pass.id, pending]);
  const [changing, setChanging] = useState(false);
  // A fresh dialog per opening, kept mounted so it can animate out.
  const [opened, setOpened] = useState(0);
  const owner = pass.ownerUserId;
  const who = pass.ownerName ?? pass.ownerEmail ?? pass.holderEmail;
  return (
    <Card>
      <CardHeader
        title="Holder"
        actions={
          pass.status === 'voided' || readOnly ? null : (
            <Button
              variant="ghost"
              size="sm"
              iconStart={<Pencil aria-hidden />}
              disabled={!holder.isSuccess || pending}
              onClick={() => {
                setOpened((n) => n + 1);
                setChanging(true);
              }}
            >
              Change
            </Button>
          )
        }
      />
      <CardBody className="flex flex-col gap-4">
        {pending ? (
          <p role="status" className="text-sm text-fg-muted">
            Holder transfer pending. Existing wallet credentials are being retired; the new holder
            cannot use the pass yet.
          </p>
        ) : holder.isError ? (
          <p role="status" className="text-sm text-fg-muted">
            Holder transfer status could not be loaded. Refresh before changing the holder.
          </p>
        ) : null}
        {holder.isSuccess && holder.data.reissueRequired ? (
          <p role="status" className="text-sm text-fg-muted">
            Automatic holder attachment needs this pass to be reissued with rotating scanner
            credentials.
          </p>
        ) : null}
        <KeyValue
          items={[
            { label: 'State', value: <StatusPill status={pass.holderState} /> },
            {
              label: 'Holder',
              value: who ? (
                <span className="inline-flex min-w-0 items-center gap-2">
                  {owner ? <EntityAvatar kind="user" id={owner} name={who} /> : null}
                  {owner ? (
                    <Link
                      to="/admin/users/$userId"
                      params={{ userId: owner }}
                      className="flex min-w-0 items-baseline gap-2 underline-offset-2 hover:underline"
                    >
                      <span className="truncate text-fg-strong">
                        {pass.ownerName ?? pass.ownerEmail}
                      </span>
                      {pass.ownerName && pass.ownerEmail ? (
                        <span className="truncate text-xs text-fg-muted">{pass.ownerEmail}</span>
                      ) : null}
                    </Link>
                  ) : (
                    <span className="truncate">{pass.holderEmail}</span>
                  )}
                </span>
              ) : null,
            },
          ]}
        />
        {pass.blockedUsers.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-sm text-fg-muted">
              This is separate from removing the pass from Wallet.
            </p>
            <p className="text-sm font-medium text-fg-strong">Removed from their account</p>
            <ListRows label="Blocked users">
              {pass.blockedUsers.map((u) => (
                <ListRow
                  key={u.id}
                  rowId={u.id}
                  leading={<EntityAvatar kind="user" id={u.id} name={u.name ?? u.id} />}
                  title={u.name ?? 'Unnamed user'}
                  trailing={
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={actions.clearBlock.isPending}
                      disabled={readOnly || !holder.isSuccess || pending}
                      onClick={() =>
                        actions.clearBlock.mutate(u.id, {
                          onSuccess: () =>
                            toast.info('Block removed; any holder transfer may still be pending.'),
                          onError: (cause) => toast.error(cause, 'Could not allow again'),
                        })
                      }
                    >
                      Allow again
                    </Button>
                  }
                />
              ))}
            </ListRows>
          </div>
        ) : null}
      </CardBody>
      {readOnly ? null : (
        <ChangeHolderDialog key={opened} pass={pass} open={changing} onOpenChange={setChanging} />
      )}
    </Card>
  );
}
