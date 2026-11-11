import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Copy, FileSignature } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { copyText } from '@/web/lib/clipboard.ts';
import { deleteConfirm } from '@/web/lib/confirms.ts';
import { formatCount } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Badge,
  Button,
  Callout,
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
import { remainingDays, WARN_DAYS } from './expiry.tsx';
import { CertificateCard, OverviewCard, SettingsCard } from './identity-cards.tsx';
import { PushCard } from './push-card.tsx';
import { useDeleteIdentity, useIdentity, useResignIdentityPasses } from './queries.ts';
import { RotateIdentityDialog } from './rotate-dialog.tsx';

const passes = (n: number) => `${formatCount(n)} ${n === 1 ? 'pass' : 'passes'}`;

export function IdentityDetailPage({ identityId }: { identityId: string }) {
  const query = useIdentity(identityId);
  const remove = useDeleteIdentity(identityId);
  const orgName = useOrgNames();
  const scope = useOrgScope();
  const navigate = useNavigate();
  const resign = useResignIdentityPasses(identityId);
  const created = useCreated(`identity:${identityId}`);
  const [confirm, setConfirm] = useState<'delete' | 'resign'>();
  const [rotating, setRotating] = useState(false);
  const [pushKeyOpen, setPushKeyOpen] = useState(false);
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
  const canManageOrg = Boolean(
    identity.orgId &&
      !scope.isLoading &&
      !scope.isError &&
      scope.memberships.some(
        (membership) =>
          membership.orgId === identity.orgId && membership.capabilities.includes('org:manage'),
      ),
  );
  const now = Date.now();
  const days = remainingDays(identity, now);
  const expired = days !== null && days < 0;
  const notYetValid = identity.notBefore !== null && identity.notBefore > now;
  const lifecycleTitle = expired
    ? 'Certificate has expired'
    : notYetValid
      ? 'Certificate is not yet valid'
      : days === null
        ? 'Certificate expiry is unknown'
        : days <= WARN_DAYS
          ? 'Certificate renewal needs review'
          : null;
  return (
    <>
      <PageHeader
        title={identity.label}
        breadcrumbs={crumbs}
        meta={
          <>
            <Badge>{orgName(identity.orgId)}</Badge>
            <span>All modes</span>
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
                Replace certificate
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
      {lifecycleTitle ? (
        <Callout
          className="mb-6"
          tone={expired || notYetValid ? 'danger' : 'warning'}
          title={lifecycleTitle}
          actions={
            uploaded ? (
              <Button size="sm" variant="outline" onClick={() => setRotating(true)}>
                Replace certificate
              </Button>
            ) : null
          }
        />
      ) : null}
      <TwoPane aside={<OverviewCard identity={identity} orgName={orgName} />}>
        {created.shown ? (
          // Next: pick it as an organization's signing identity in its authorized workspace.
          <CreatedCallout
            title="Identity uploaded"
            onDismiss={created.dismiss}
            actions={
              <>
                {identity.pushMethod === 'none' ? (
                  <Button size="sm" variant="outline" onClick={() => setPushKeyOpen(true)}>
                    Add push key
                  </Button>
                ) : null}
                <Button asChild size="sm" iconEnd={<ChevronRight aria-hidden />}>
                  {identity.orgId && canManageOrg ? (
                    <Link
                      to="/admin/orgs/$orgId"
                      params={{ orgId: identity.orgId }}
                      search={{ view: 'workspace', orgId: identity.orgId }}
                    >
                      Use in {orgName(identity.orgId)}
                    </Link>
                  ) : identity.orgId ? (
                    <Link to="/admin/orgs/$orgId" params={{ orgId: identity.orgId }}>
                      View {orgName(identity.orgId)}
                    </Link>
                  ) : (
                    <Link to="/admin/orgs">Use in an organization</Link>
                  )}
                </Button>
              </>
            }
          />
        ) : null}
        <CertificateCard identity={identity} now={Date.now()} />
        <PushCard
          identity={identity}
          dialogOpen={pushKeyOpen}
          onDialogOpenChange={setPushKeyOpen}
        />
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
