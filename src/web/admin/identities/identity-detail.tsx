import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Copy, FileSignature } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { copyText } from '@/web/lib/clipboard.ts';
import { deleteConfirm } from '@/web/lib/confirms.ts';
import { formatCount } from '@/web/lib/format.ts';
import {
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  detailError,
  MoreMenu,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  TwoPane,
  toast,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { CreatedCallout, useCreated } from '../passes/created.tsx';
import { CertificateCard, OverviewCard, PushSetupCard, SettingsCard } from './identity-cards.tsx';
import { useDeleteIdentity, useIdentity, useResignIdentityPasses } from './queries.ts';
import { RotateIdentityDialog } from './rotate-dialog.tsx';

const passes = (n: number) => `${formatCount(n)} ${n === 1 ? 'pass' : 'passes'}`;

export function IdentityDetailPage({ identityId }: { identityId: string }) {
  const query = useIdentity(identityId);
  const remove = useDeleteIdentity(identityId);
  const orgName = useOrgNames();
  const navigate = useNavigate();
  const resign = useResignIdentityPasses(identityId);
  const created = useCreated(`identity:${identityId}`);
  const [confirm, setConfirm] = useState<'delete' | 'resign'>();
  const [rotating, setRotating] = useState(false);
  const crumbs = [
    { label: 'Apple identities', to: '/admin/identities' },
    { label: query.data?.label ?? 'Identity' },
  ];

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Identity" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading identity" />
      </>
    );
  }
  if (query.isError) {
    return detailError(query, {
      entity: 'identity',
      to: '/admin/identities',
      header: <PageHeader title="Identity" breadcrumbs={crumbs} />,
    });
  }
  const identity = query.data;
  const uploaded = identity.source === 'db';
  return (
    <>
      <PageHeader
        title={identity.label}
        breadcrumbs={crumbs}
        meta={
          <>
            {identity.isDefault ? <StatusPill status="default" /> : null}
            <span className="font-mono text-xs">{identity.passTypeIdentifier}</span>
            {uploaded ? null : <span>From environment</span>}
          </>
        }
        actions={
          <MoreMenu>
            <DropdownMenuItem
              onSelect={() => void copyText(identity.passTypeIdentifier, 'pass type ID')}
            >
              <Copy aria-hidden />
              Copy pass type ID
            </DropdownMenuItem>
            {uploaded ? (
              <DropdownMenuItem onSelect={() => setRotating(true)}>
                <ACTION_ICON.rotate aria-hidden />
                Rotate certificate
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={identity.passCount === 0}
              onSelect={() => setConfirm('resign')}
            >
              <FileSignature aria-hidden />
              Re-sign {passes(identity.passCount)}
            </DropdownMenuItem>
            {uploaded ? (
              <DropdownMenuItem destructive onSelect={() => setConfirm('delete')}>
                <ACTION_ICON.delete aria-hidden />
                Delete
              </DropdownMenuItem>
            ) : null}
          </MoreMenu>
        }
      />
      <TwoPane aside={<OverviewCard identity={identity} orgName={orgName} />}>
        {created.shown ? (
          // Next: pick it as an org's signing identity (org detail, Details).
          <CreatedCallout
            title="Identity uploaded"
            onDismiss={created.dismiss}
            actions={
              <Button asChild size="sm" iconEnd={<ChevronRight aria-hidden />}>
                {identity.orgId ? (
                  <Link to="/admin/orgs/$orgId" params={{ orgId: identity.orgId }}>
                    Use in {orgName(identity.orgId)}
                  </Link>
                ) : (
                  <Link to="/admin/orgs">Use in an organization</Link>
                )}
              </Button>
            }
          />
        ) : null}
        <CertificateCard identity={identity} now={Date.now()} />
        <PushSetupCard identity={identity} />
        <SettingsCard
          key={`${identity.label}|${identity.apnsBinding}|${identity.nfcEnabled}|${identity.isDefault}`}
          identity={identity}
        />
      </TwoPane>
      <RotateIdentityDialog identityId={identityId} open={rotating} onOpenChange={setRotating} />
      <ConfirmDialog
        open={confirm === 'resign'}
        onOpenChange={(o) => !o && setConfirm(undefined)}
        title={`Re-sign ${passes(identity.passCount)}?`}
        description={`Each pass signed by ${identity.label} is rebuilt with the current certificate. Devices get it on their next refresh.`}
        confirmLabel="Re-sign"
        destructive
        onConfirm={async () => {
          await resign.mutateAsync();
          toast.success('Re-sign started');
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(undefined)}
        {...deleteConfirm('identity', identity.label)}
        destructive
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('Identity deleted');
          await navigate({ to: '/admin/identities', replace: true });
        }}
      />
    </>
  );
}
