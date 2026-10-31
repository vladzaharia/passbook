import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  CodeBlock,
  ConfirmDialog,
  ErrorState,
  FormField,
  Input,
  KeyValue,
  PageHeader,
  SaveBar,
  SkeletonRows,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { formatDateTime } from '../overview/format.ts';
import { ApnsPill, ExpiryPill } from './expiry.tsx';
import { useDeleteIdentity, useIdentity, useUpdateIdentity } from './queries.ts';

type Identity = z.infer<typeof IdentitySchema>;

const MTLS_STEPS = `npx wrangler mtls-certificate upload --cert cert.pem --key key.pem --name <identity>
# wrangler.jsonc
"mtls_certificates": [{ "binding": "APNS_<IDENTITY>", "certificate_id": "<id from upload>" }]`;

function ApnsHelp({ identity }: { identity: Identity }) {
  if (identity.apnsAvailable) return null;
  return (
    <Card>
      <CardHeader title="APNs binding missing" />
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">
          Pushes need an mTLS binding for this certificate. Passes still update when the holder
          refreshes in Wallet.
        </p>
        <CodeBlock code={MTLS_STEPS} label="APNs binding steps" maxHeight="max-h-40" />
        <p className="text-sm text-fg-muted">
          Deploy, then set the binding name below (for example <code>APNS_ACME</code>).
        </p>
      </CardBody>
    </Card>
  );
}

function EditCard({ identity }: { identity: Identity }) {
  const update = useUpdateIdentity(identity.id);
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
        apnsBinding: draft.binding.trim() || null,
      });
      toast.success('Identity saved');
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setErrors(cause.fields);
      else toast.error(errorMessage(cause));
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
          <FormField label="Label" required error={errors.label}>
            {(p) => (
              <Input
                {...p}
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            )}
          </FormField>
          <FormField
            label="APNs binding"
            error={errors.apnsBinding}
            help="Name of the mTLS binding in the Worker env."
          >
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={draft.binding}
                onChange={(e) => setDraft({ ...draft, binding: e.target.value })}
              />
            )}
          </FormField>
          <CheckboxField
            label="NFC enabled"
            checked={draft.nfc}
            onCheckedChange={(c) => setDraft({ ...draft, nfc: c === true })}
          />
          <CheckboxField
            label="Default identity"
            checked={draft.isDefault}
            disabled={identity.isDefault}
            onCheckedChange={(c) => setDraft({ ...draft, isDefault: c === true })}
          />
        </form>
      </CardBody>
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
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

export function IdentityDetailPage({ identityId }: { identityId: string }) {
  const query = useIdentity(identityId);
  const remove = useDeleteIdentity(identityId);
  const orgName = useOrgNames();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const crumbs = [
    { label: 'Apple identities', to: '/admin/identities' },
    { label: query.data?.label ?? 'Identity' },
  ];

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Identity" breadcrumbs={crumbs} />
        <SkeletonRows label="Loading identity" />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title="Identity" breadcrumbs={crumbs} />
        <ErrorState
          error={query.error}
          title={
            isApiError(query.error) && query.error.isNotFound ? 'Identity not found' : undefined
          }
          onRetry={() => query.refetch()}
        />
      </>
    );
  }
  const identity = query.data;
  return (
    <>
      <PageHeader
        title={identity.label}
        breadcrumbs={crumbs}
        actions={
          identity.source === 'db' ? (
            <Button variant="danger" onClick={() => setConfirm(true)}>
              Delete
            </Button>
          ) : null
        }
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <CardHeader
            title="Certificate"
            actions={
              <>
                {identity.isDefault ? <Badge tone="accent">Default</Badge> : null}
                {identity.source === 'env' ? <Badge>From environment</Badge> : null}
              </>
            }
          />
          <CardBody>
            <KeyValue
              items={[
                { label: 'Pass type ID', value: identity.passTypeIdentifier, mono: true },
                { label: 'Team ID', value: identity.teamIdentifier, mono: true },
                { label: 'Owner', value: orgName(identity.orgId) },
                { label: 'SHA-256', value: identity.certSha256, mono: true },
                { label: 'Valid from', value: formatDateTime(identity.notBefore) },
                { label: 'Expires', value: <ExpiryPill identity={identity} now={Date.now()} /> },
                { label: 'APNs', value: <ApnsPill identity={identity} /> },
                { label: 'Created', value: formatDateTime(identity.createdAt) },
              ]}
            />
          </CardBody>
        </Card>
        <ApnsHelp identity={identity} />
        <EditCard
          key={`${identity.label}|${identity.apnsBinding}|${identity.nfcEnabled}|${identity.isDefault}`}
          identity={identity}
        />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${identity.label}?`}
        description="Templates and orgs using this identity fall back to the default."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('Identity deleted');
          await navigate({ to: '/admin/identities' });
        }}
      />
    </>
  );
}
