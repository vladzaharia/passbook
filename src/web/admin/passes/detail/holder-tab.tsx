import { Link } from '@tanstack/react-router';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  Dialog,
  DialogContent,
  EntityAvatar,
  FormField,
  Input,
  KeyValue,
  ListRow,
  ListRows,
  StatusPill,
  toast,
} from '../../../ui/index.ts';
import { usePassActions } from '../api.ts';
import { newKey } from '../format.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const [email, setEmail] = useState(pass.holderEmail ?? '');
  const [send, setSend] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const owned = pass.holderState === 'owned';
  const trimmed = email.trim();
  const valid = EMAIL.test(trimmed);
  const same = trimmed.toLowerCase() === (pass.holderEmail ?? '').toLowerCase();

  async function save() {
    if (!valid) return setError('Enter a valid email.');
    setBusy(true);
    setError(undefined);
    try {
      if (owned) await actions.reassign.mutateAsync(trimmed);
      else await actions.assign.mutateAsync(trimmed);
      if (send) await actions.resendEmail.mutateAsync({ to: trimmed, key: newKey() });
      toast.success(send ? `Pass sent to ${trimmed}` : 'Holder changed');
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title="Change holder"
        description={
          owned ? 'The current owner loses the pass once the new holder signs in.' : undefined
        }
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!trimmed || same} onClick={() => void save()}>
              {send ? 'Change and send' : 'Change holder'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <FormField label="Email" error={error}>
            {(c) => (
              <Input
                {...c}
                data-autofocus
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </FormField>
          <CheckboxField
            label={valid ? `Email the pass to ${trimmed}` : 'Email the pass'}
            checked={send}
            onCheckedChange={(c) => setSend(c === true)}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One card: the holder's state and who it is, with Change. Clear lives in the header's More. */
export function HolderTab({ pass }: { pass: PassDetailDto }) {
  const actions = usePassActions(pass.id);
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
          pass.status === 'voided' ? null : (
            <Button
              variant="ghost"
              size="sm"
              iconStart={<Pencil aria-hidden />}
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
                      to={`/admin/users/${owner}` as never}
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
                      onClick={() =>
                        actions.clearBlock.mutate(u.id, {
                          onSuccess: () => toast.success('They can add it again'),
                          onError: (cause) => toast.error(cause),
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
      <ChangeHolderDialog key={opened} pass={pass} open={changing} onOpenChange={setChanging} />
    </Card>
  );
}
