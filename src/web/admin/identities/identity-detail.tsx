import { useNavigate } from '@tanstack/react-router';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  DropdownMenuItem,
  ErrorState,
  FormField,
  Input,
  KeyValue,
  PageHeader,
  SaveBar,
  SkeletonRows,
  StatusPill,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { MoreMenu } from '../connections/more-menu.tsx';
import { SwitchRow } from '../connections/switch-row.tsx';
import { useOrgNames } from '../orgs/queries.ts';
import { formatDateTime } from '../overview/format.ts';
import { CheckApnsButton } from './apns-check.tsx';
import { ApnsPill, ExpiryPill } from './expiry.tsx';
import {
  useDeleteIdentity,
  useIdentity,
  useResignIdentityPasses,
  useUpdateIdentity,
} from './queries.ts';
import { RotateIdentityDialog } from './rotate-dialog.tsx';

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
          {identity.source === 'env' ? (
            <>Set APNS in wrangler.jsonc and deploy.</>
          ) : (
            <>
              Deploy, then set the binding name below (for example <code>APNS_ACME</code>).
            </>
          )}
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
        ...(identity.source === 'db' && draft.binding !== initial.binding
          ? { apnsBinding: draft.binding.trim() || null }
          : {}),
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
          {identity.source === 'db' ? (
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
          ) : (
            <KeyValue
              items={[
                { label: 'APNs binding', value: identity.apnsBinding ?? 'Not set', mono: true },
              ]}
            />
          )}
          <SwitchRow
            label="NFC enabled"
            checked={draft.nfc}
            onCheckedChange={(c) => setDraft({ ...draft, nfc: c })}
          />
          <SwitchRow
            label="Default identity"
            checked={draft.isDefault}
            disabled={identity.isDefault}
            onCheckedChange={(c) => setDraft({ ...draft, isDefault: c })}
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
  const resign = useResignIdentityPasses(identityId);
  const [confirm, setConfirm] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);
  const [rotating, setRotating] = useState(false);
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
        width="detail"
        title={identity.label}
        breadcrumbs={crumbs}
        meta={
          <>
            {identity.isDefault ? <StatusPill status="default" /> : null}
            {identity.source === 'env' ? <span>From environment</span> : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setConfirmResign(true)}>
              Re-sign all passes
            </Button>
            {identity.source === 'db' ? (
              <MoreMenu>
                <DropdownMenuItem onSelect={() => setRotating(true)}>
                  <RefreshCw aria-hidden />
                  Rotate certificate
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => setConfirm(true)}>
                  <Trash2 aria-hidden />
                  Delete
                </DropdownMenuItem>
              </MoreMenu>
            ) : null}
          </>
        }
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <CardHeader title="Certificate" />
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
        {identity.apnsAvailable ? (
          <Card>
            <CardHeader title="APNs" />
            <CardBody>
              <CheckApnsButton identityId={identity.id} />
            </CardBody>
          </Card>
        ) : null}
        <EditCard
          key={`${identity.label}|${identity.apnsBinding}|${identity.nfcEnabled}|${identity.isDefault}`}
          identity={identity}
        />
      </div>
      <RotateIdentityDialog identityId={identityId} open={rotating} onOpenChange={setRotating} />
      <ConfirmDialog
        open={confirmResign}
        onOpenChange={setConfirmResign}
        title="Re-sign all passes?"
        description={`Rebuilds every pass signed by ${identity.label} with the current certificate. Devices pick up the new signature on their next refresh.`}
        confirmLabel="Re-sign"
        onConfirm={async () => {
          await resign.mutateAsync();
          toast.success('Re-sign started');
        }}
      />
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
