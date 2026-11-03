import { type ReactElement, useState } from 'react';
import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { formatCount, formatDateTime } from '@/web/lib/format.ts';
import {
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  FormField,
  Input,
  KeyValue,
  SaveBar,
  SwitchRow,
  Tooltip,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { ApnsRow } from './apns-check.tsx';
import { ExpiryPill } from './expiry.tsx';
import { useUpdateIdentity } from './queries.ts';

type Identity = z.infer<typeof IdentitySchema>;

const MTLS_STEPS = `npx wrangler mtls-certificate upload --cert cert.pem --key key.pem --name <identity>
# wrangler.jsonc
"mtls_certificates": [{ "binding": "APNS_<IDENTITY>", "certificate_id": "<id from upload>" }]`;

/** Every read-only fact about the certificate, with the APNs row last. */
export function CertificateCard({ identity, now }: { identity: Identity; now: number }) {
  return (
    <Card>
      <CardHeader title="Certificate" />
      <CardBody className="flex flex-col gap-4">
        <KeyValue
          items={[
            { label: 'Pass type ID', value: identity.passTypeIdentifier, mono: true },
            { label: 'Team ID', value: identity.teamIdentifier, mono: true },
            { label: 'Expires', value: <ExpiryPill identity={identity} now={now} /> },
            { label: 'Valid from', value: formatDateTime(identity.notBefore, '—') },
            { label: 'SHA-256', value: identity.certSha256, mono: true },
            {
              label: 'APNs binding',
              value: identity.apnsBinding ?? (identity.source === 'env' ? 'APNS' : null),
              mono: true,
            },
          ]}
        />
        <div className="border-t border-border pt-4">
          <ApnsRow identity={identity} />
        </div>
      </CardBody>
    </Card>
  );
}

/** Shown while the deployment has no mTLS binding for this certificate. */
export function PushSetupCard({ identity }: { identity: Identity }) {
  if (identity.apnsAvailable) return null;
  return (
    <Card>
      <CardHeader title="Push setup" />
      <CardBody className="flex flex-col gap-3">
        <p className="max-w-[65ch] text-sm text-fg-muted">
          Passes update when holders refresh in Wallet. Pushes need an mTLS binding.
        </p>
        <CodeBlock code={MTLS_STEPS} label="APNs binding steps" maxHeight="max-h-40" />
      </CardBody>
    </Card>
  );
}

function Locked({ locked, children }: { locked: boolean; children: ReactElement }) {
  return locked ? (
    <Tooltip content="Set in the environment">
      <div>{children}</div>
    </Tooltip>
  ) : (
    children
  );
}

/** Switches plus the label (and, for uploaded identities, the APNs binding name). */
export function SettingsCard({ identity }: { identity: Identity }) {
  const update = useUpdateIdentity(identity.id);
  const env = identity.source === 'env';
  const initial = {
    label: identity.label,
    nfc: identity.nfcEnabled,
    isDefault: identity.isDefault,
    binding: identity.apnsBinding ?? '',
  };
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useUnsavedChangesGuard(dirty);

  async function save() {
    setErrors({});
    if (!draft.label.trim()) return setErrors({ label: 'Required.' });
    try {
      await update.mutateAsync({
        label: draft.label.trim(),
        nfcEnabled: draft.nfc,
        isDefault: draft.isDefault,
        ...(!env && draft.binding !== initial.binding
          ? { apnsBinding: draft.binding.trim() || null }
          : {}),
      });
      toast.success('Identity saved');
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setErrors(cause.fields);
      else toast.error(cause, 'Could not save');
    }
  }

  return (
    <Card>
      <CardHeader title="Settings" />
      <CardBody>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Label" required error={errors.label}>
              {(p) => (
                <Input
                  {...p}
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                />
              )}
            </FormField>
            {env ? null : (
              <FormField label="APNs binding" error={errors.apnsBinding}>
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    placeholder="APNS_ACME"
                    spellCheck={false}
                    autoCapitalize="characters"
                    value={draft.binding}
                    onChange={(e) => setDraft({ ...draft, binding: e.target.value })}
                  />
                )}
              </FormField>
            )}
          </div>
          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <SwitchRow
              label="NFC"
              help="The pass type ID has Apple's NFC entitlement."
              checked={draft.nfc}
              onCheckedChange={(c) => setDraft({ ...draft, nfc: c })}
            />
            <Locked locked={env}>
              <SwitchRow
                label="Default identity"
                help={env ? 'Set in the environment' : 'Signs passes of orgs without their own.'}
                checked={draft.isDefault}
                disabled={env || identity.isDefault}
                onCheckedChange={(c) => setDraft({ ...draft, isDefault: c })}
              />
            </Locked>
          </div>
        </form>
      </CardBody>
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        paused={update.isPaused}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(initial);
          setErrors({});
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}

export function OverviewCard({
  identity,
  orgName,
}: {
  identity: Identity;
  orgName: (id: string | null) => string;
}) {
  return (
    <Card>
      <CardHeader title="Overview" />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Owner', value: orgName(identity.orgId) },
            {
              label: 'Passes',
              value: (
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <ENTITY.pass.icon aria-hidden className="size-4 text-fg-muted" />
                  {formatCount(identity.passCount)}
                </span>
              ),
            },
            { label: 'Source', value: identity.source === 'env' ? 'Environment' : 'Uploaded' },
            { label: 'Added', value: formatDateTime(identity.createdAt) },
          ]}
        />
      </CardBody>
    </Card>
  );
}
