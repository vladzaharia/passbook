import { Link, useNavigate } from '@tanstack/react-router';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { deleteConfirm } from '@/web/lib/confirms.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  DropdownMenuItem,
  detailError,
  EntityAvatar,
  KeyValue,
  MetaLink,
  MoreMenu,
  PageHeader,
  SkeletonDetail,
  TechnicalDetails,
  TwoPane,
  TypedConfirmDialog,
  toast,
} from '@/web/ui/index.ts';
import { CreatedCallout, useCreated } from '../passes/created.tsx';
import { BootstrapOrgAdmin, ProvisioningCounts } from './org-provisioning.tsx';
import { OrgStatus } from './orgs-page.tsx';
import { useDeleteOrg, useOrg, useSetOrgStatus } from './queries.ts';

/** Suspend is undone from its toast; Reactivate just runs. Neither asks first. */
function useStatusToggle(orgId: string) {
  const setStatus = useSetOrgStatus(orgId);
  const suspend = async () => {
    try {
      await setStatus.mutateAsync('suspended');
      toast.undo('Organization suspended', () => setStatus.mutateAsync('active'));
    } catch (cause) {
      toast.error(cause, 'Could not suspend');
    }
  };
  const reactivate = async () => {
    try {
      await setStatus.mutateAsync('active');
      toast.success('Organization reactivated');
    } catch (cause) {
      toast.error(cause, 'Could not reactivate');
    }
  };
  return { suspend, reactivate, pending: setStatus.isPending };
}

/** Platform provisioning is independent of tenant membership and never loads a workspace. */
export function OrgDetailPage({
  orgId,
  canOpenWorkspace,
}: {
  orgId: string;
  canOpenWorkspace: boolean;
}) {
  const query = useOrg(orgId);
  const remove = useDeleteOrg(orgId);
  const status = useStatusToggle(orgId);
  const created = useCreated(`org:${orgId}`);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const crumbs = [
    { label: 'Organizations', to: '/admin/orgs' },
    { label: query.data?.name ?? 'Organization' },
  ];

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Organization" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading organization" />
      </>
    );
  }
  if (
    !query.data ||
    (query.isError &&
      isApiError(query.error) &&
      (query.error.isUnauthorized || query.error.isForbidden || query.error.isNotFound))
  ) {
    return detailError(query, {
      entity: 'org',
      to: '/admin/orgs',
      header: <PageHeader title="Organization" breadcrumbs={crumbs} />,
    });
  }
  const org = query.data;
  const suspended = org.status === 'suspended';
  const { typed: _typed, ...confirmCopy } = deleteConfirm('org', org.name);
  return (
    <>
      <PageHeader
        title={org.name}
        breadcrumbs={crumbs}
        avatar={<EntityAvatar kind="org" id={org.id} name={org.name} size={40} />}
        meta={
          <>
            <OrgStatus status={org.status} />
            <span className="font-mono text-xs">{org.slug}</span>
            <MetaLink to="/admin/audit" search={{ filterOrgId: org.id }} icon={ENTITY.audit.icon}>
              Audit log
            </MetaLink>
          </>
        }
        actions={
          <>
            {canOpenWorkspace ? (
              <Button asChild variant="outline">
                <Link
                  to="/admin/orgs/$orgId"
                  params={{ orgId: org.id }}
                  search={{ view: 'workspace', orgId: org.id }}
                >
                  Open workspace
                </Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              loading={status.pending}
              iconStart={suspended ? <Play aria-hidden /> : <Pause aria-hidden />}
              onClick={() => void (suspended ? status.reactivate() : status.suspend())}
            >
              {suspended ? 'Reactivate' : 'Suspend'}
            </Button>
            <MoreMenu>
              <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
                <ACTION_ICON.delete aria-hidden />
                Delete
              </DropdownMenuItem>
            </MoreMenu>
          </>
        }
      />
      {query.isRefetchError ? (
        <Callout
          tone="warning"
          className="mb-6"
          title="Organization refresh failed"
          actions={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry organization
            </Button>
          }
        >
          The displayed provisioning details may be out of date.
        </Callout>
      ) : null}
      <TwoPane
        aside={
          <>
            <ProvisioningCounts org={org} />
            <Card>
              <CardHeader title="Overview" />
              <CardBody>
                <KeyValue
                  items={[
                    { label: 'Slug', value: org.slug, mono: true },
                    { label: 'Created', value: formatDateTime(org.createdAt) },
                  ]}
                />
                <TechnicalDetails className="mt-3" items={[{ label: 'ID', value: org.id }]} />
              </CardBody>
            </Card>
          </>
        }
      >
        {created.shown ? (
          <CreatedCallout
            title="Organization created"
            onDismiss={created.dismiss}
            actions={
              canOpenWorkspace ? (
                <Button asChild size="sm">
                  <Link
                    to="/admin/orgs/$orgId"
                    params={{ orgId: org.id }}
                    search={{ view: 'workspace', orgId: org.id }}
                  >
                    Open workspace
                  </Link>
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {suspended ? (
          <Callout tone="warning">
            Suspended: passes do not update and its API keys do not work.
          </Callout>
        ) : null}
        <Card>
          <CardHeader title="Lifecycle" actions={<OrgStatus status={org.status} />} />
          <CardBody className="flex flex-col gap-2 text-sm text-fg-muted">
            <p>
              Suspending this organization stops pass updates and its API keys from working.
              Reactivate it to allow those functions again.
            </p>
            <p>
              Deletion removes the organization from use, but retains pass and audit references.
              Neither action erases an offline Wallet copy.
            </p>
          </CardBody>
        </Card>
        <BootstrapOrgAdmin orgId={org.id} active={org.status === 'active'} />
        <Card>
          <CardHeader
            title="Signing identities"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link to="/admin/identities">Manage identities</Link>
              </Button>
            }
          />
          <CardBody className="text-sm text-fg-muted">
            Manage platform signing identities in the directory. The organization&apos;s saved
            default is available in its authorized workspace.
          </CardBody>
        </Card>
      </TwoPane>
      <TypedConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        {...confirmCopy}
        description={`${confirmCopy.description} Pass and audit records retain their organization reference; offline Wallet copies are not erased.`}
        word={org.slug}
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('Organization deleted');
          // The deleted org's page leaves history: Back lands on the list, not on Not found.
          await navigate({ to: '/admin/orgs', replace: true });
        }}
      />
    </>
  );
}
