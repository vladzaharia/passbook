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
  Form,
  FormField,
  Input,
  KeyValue,
  SaveBar,
  SwitchRow,
  Tooltip,
  toast,
  UnsavedChangesDialog,
  useFormErrors,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { ExpiryPill } from './expiry.tsx';
import { useUpdateIdentity } from './queries.ts';

type Identity = z.infer<typeof IdentitySchema>;

/** Every read-only fact about the certificate. */
export function CertificateCard({ identity, now }: { identity: Identity; now: number }) {
  return (
    <Card>
      <CardHeader title="Certificate" />
      <CardBody>
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
  const [server, setServer] = useState<Record<string, string>>({});
  const check = useFormErrors(draft.label.trim() ? {} : { label: 'Required.' });
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useUnsavedChangesGuard(dirty);
  const edit = (p: Partial<typeof initial>) => {
    setDraft({ ...draft, ...p });
    setServer({});
  };

  async function save() {
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
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      else toast.error(cause, 'Could not save');
    }
  }
  const formId = `identity-${identity.id}`;

  return (
    <Card>
      <CardHeader title="Settings" />
      <CardBody>
        <Form
          id={formId}
          className="flex flex-col gap-4"
          {...check.form}
          onValid={() => void save()}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Label" required error={errors.label}>
              {(p) => (
                <Input
                  {...p}
                  value={draft.label}
                  onChange={(e) => edit({ label: e.target.value })}
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
                    onChange={(e) => edit({ binding: e.target.value })}
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
              onCheckedChange={(c) => edit({ nfc: c })}
            />
            <Locked locked={env}>
              <SwitchRow
                label="Default identity"
                help={env ? 'Set in the environment' : 'Signs passes of orgs without their own.'}
                checked={draft.isDefault}
                disabled={env || identity.isDefault}
                onCheckedChange={(c) => edit({ isDefault: c })}
              />
            </Locked>
          </div>
        </Form>
      </CardBody>
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        paused={update.isPaused}
        formId={formId}
        onDiscard={() => {
          setDraft(initial);
          setServer({});
          check.reset();
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
