import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  FormField,
  Input,
  KeyValue,
  StatusPill,
  toast,
} from '../../../ui/index.ts';
import { usePassActions } from '../api.ts';

type Pass = z.infer<typeof PassDetailSchema>;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function HolderTab({ pass }: { pass: Pass }) {
  const actions = usePassActions(pass.id);
  const [email, setEmail] = useState(pass.holderEmail ?? '');
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<'reassign' | 'clear' | null>(null);
  const owned = pass.holderState === 'owned';
  const trimmed = email.trim();
  const unchanged = trimmed.toLowerCase() === (pass.holderEmail ?? '').toLowerCase();

  function check(): boolean {
    if (!EMAIL.test(trimmed)) {
      setError('Enter a valid email.');
      return false;
    }
    setError(undefined);
    return true;
  }

  async function assign() {
    if (!check()) return;
    try {
      await actions.assign.mutateAsync(trimmed);
      toast.success('Holder updated');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="grid max-w-2xl gap-4">
      <Card>
        <CardHeader title="Holder" />
        <CardBody>
          <KeyValue
            items={[
              { label: 'State', value: <StatusPill status={pass.holderState} /> },
              { label: 'Email', value: pass.holderEmail },
              {
                label: 'Owner',
                value: pass.ownerUserId ? (
                  <Link
                    to={`/admin/users/${pass.ownerUserId}` as never}
                    className="text-accent-fg hover:underline"
                  >
                    {pass.ownerUserId}
                  </Link>
                ) : null,
              },
            ]}
          />
        </CardBody>
      </Card>
      {pass.blockedUsers.length > 0 ? (
        <Card>
          <CardHeader title="Blocked users" />
          <CardBody>
            <ul className="grid gap-2">
              {pass.blockedUsers.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{u.name ?? u.id}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={actions.clearBlock.isPending}
                    onClick={() =>
                      actions.clearBlock.mutate(u.id, {
                        onSuccess: () => toast.success('Block cleared'),
                        onError: (cause) => toast.error(cause, 'Could not clear block'),
                      })
                    }
                  >
                    Clear block
                  </Button>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
      <FormField label="Holder email" error={error}>
        {(c) => (
          <div className="flex gap-2">
            <Input
              {...c}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {owned ? (
              <Button
                variant="outline"
                disabled={unchanged || !trimmed}
                onClick={() => check() && setConfirm('reassign')}
              >
                Reassign
              </Button>
            ) : (
              <Button
                loading={actions.assign.isPending}
                disabled={unchanged || !trimmed}
                onClick={() => void assign()}
              >
                Assign
              </Button>
            )}
          </div>
        )}
      </FormField>
      {pass.holderState !== 'unassigned' ? (
        <div>
          <Button variant="outline" onClick={() => setConfirm('clear')}>
            Clear holder
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm === 'reassign'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Reassign pass?"
        description={`The current owner loses the pass. It goes to ${trimmed} once that email is verified.`}
        confirmLabel="Reassign"
        destructive
        onConfirm={async () => {
          await actions.reassign.mutateAsync(trimmed);
          toast.success('Pass reassigned');
        }}
      />
      <ConfirmDialog
        open={confirm === 'clear'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Clear holder?"
        description={owned ? 'The owner loses the pass.' : 'The pass becomes unassigned.'}
        confirmLabel="Clear"
        destructive
        onConfirm={async () => {
          await actions.unassign.mutateAsync();
          setEmail('');
          toast.success('Holder cleared');
        }}
      />
    </div>
  );
}
