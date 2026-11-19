import { useState } from 'react';
import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  KeyValue,
  toast,
} from '@/web/ui/index.ts';
import { ApnsRow, PUSH_METHOD_LABEL } from './apns-check.tsx';
import { PushKeyDialog } from './push-key-dialog.tsx';
import { useRemovePushKey } from './queries.ts';

type Identity = z.infer<typeof IdentitySchema>;

const MTLS_STEPS = `npx wrangler mtls-certificate upload --cert cert.pem --key key.pem --name <identity>
# wrangler.jsonc
"mtls_certificates": [{ "binding": "APNS_<IDENTITY>", "certificate_id": "<id from upload>" }]`;

/** How pushes reach Apple for this identity: its mTLS binding, else the team's .p8 key. */
export function PushCard({
  identity,
  dialogOpen,
  onDialogOpenChange,
}: {
  identity: Identity;
  dialogOpen: boolean;
  onDialogOpenChange: (open: boolean) => void;
}) {
  const remove = useRemovePushKey(identity.id);
  const [removing, setRemoving] = useState(false);
  const key = identity.pushKey;
  const shared = (key?.identityCount ?? 0) > 1;
  const dependents = key?.dependentCount ?? 0;
  const none = identity.pushMethod === 'none';
  const bound = identity.pushMethod === 'certificate';
  const bindingFailing = bound && identity.apnsHealth === 'failing';

  return (
    <Card>
      <CardHeader title="Push" />
      <CardBody className="flex flex-col gap-4">
        <KeyValue
          items={[
            { label: 'Method', value: PUSH_METHOD_LABEL[identity.pushMethod] },
            ...(key
              ? [
                  { label: 'Push key ID', value: key.keyId, mono: true },
                  {
                    label: key.rotatedAt ? 'Rotated' : 'Added',
                    value: formatDateTime(key.rotatedAt ?? key.createdAt),
                  },
                  {
                    label: 'Team',
                    value: shared
                      ? `${identity.teamIdentifier}, ${key.identityCount} identities`
                      : identity.teamIdentifier,
                    mono: true,
                  },
                ]
              : []),
          ]}
        />
        <div className="border-t border-border pt-4">
          <ApnsRow identity={identity} />
        </div>
        {none ? (
          <p className="max-w-[65ch] text-sm text-fg-muted">
            Passes update when holders refresh in Wallet. Add a push key to update them right away.
          </p>
        ) : bound && key ? (
          <p className="max-w-[65ch] text-sm text-fg-muted">
            {bindingFailing
              ? 'The binding is failing. Remove the APNS binding to push with this key.'
              : 'Pushes use the certificate binding. This key takes over when the binding is removed.'}
          </p>
        ) : bindingFailing ? (
          <p className="max-w-[65ch] text-sm text-fg-muted">
            The binding is failing. Add a push key to push without it.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={none || (bindingFailing && !key) ? 'primary' : 'outline'}
            iconStart={
              key ? <ACTION_ICON.rotate aria-hidden /> : <ACTION_ICON.pushKey aria-hidden />
            }
            onClick={() => onDialogOpenChange(true)}
          >
            {key ? 'Replace key' : 'Add push key'}
          </Button>
          {key ? (
            <Button
              size="sm"
              variant="ghost"
              iconStart={<ACTION_ICON.delete aria-hidden />}
              onClick={() => setRemoving(true)}
            >
              Remove key
            </Button>
          ) : null}
        </div>
        {none || identity.pushMethod === 'key' ? (
          <details className="text-sm text-fg-muted">
            <summary className="cursor-pointer text-fg">Certificate binding steps</summary>
            <div className="mt-2">
              <CodeBlock code={MTLS_STEPS} label="APNs binding steps" maxHeight="max-h-40" />
            </div>
          </details>
        ) : null}
      </CardBody>
      <PushKeyDialog
        identityId={identity.id}
        team={identity.teamIdentifier}
        replacing={Boolean(key)}
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove push key?"
        description={removeCopy(bound, dependents, identity.teamIdentifier)}
        confirmLabel="Remove key"
        destructive
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('Push key removed');
        }}
      />
    </Card>
  );
}

// Unbound: dependents includes this identity. Bound: it counts only the others.
function removeCopy(bound: boolean, dependents: number, team: string): string {
  if (dependents > (bound ? 0 : 1)) {
    const noun = dependents === 1 ? 'identity' : 'identities';
    return `${dependents} ${noun} of team ${team} lose push until a key or binding is set.`;
  }
  if (bound) return 'Pushes keep using the certificate binding.';
  return 'Passes update only when holders refresh in Wallet until a new key or binding is set.';
}
