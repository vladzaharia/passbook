import { Link } from '@tanstack/react-router';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  detailError,
  PageHeader,
  SaveBarGroup,
  SkeletonDetail,
} from '@/web/ui/index.ts';
import { DataCard } from '../settings/data-card.tsx';
import { OrgSettingsSections } from '../settings/org-settings-page.tsx';
import { OrgFacts } from './org-facts.tsx';
import { OrgForm } from './org-form.tsx';
import { OrgStatus } from './orgs-page.tsx';
import { useOrgWorkspace } from './queries.ts';

/** Mounted only after the URL and actual org:read membership have been validated. */
export function OrgWorkspacePage({
  orgId,
  membership,
  isAdmin,
}: {
  orgId: string;
  membership: OrgMembership;
  isAdmin: boolean;
}) {
  const query = useOrgWorkspace(orgId);
  const canManage = membership.capabilities.includes('org:manage');
  if (query.isPending) {
    return (
      <>
        <PageHeader title="Settings" />
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
      to: isAdmin ? '/admin/orgs' : '/admin/account',
      header: <PageHeader title="Settings" />,
    });
  }
  const org = query.data;
  return (
    <SaveBarGroup>
      <PageHeader
        title="Settings"
        meta={
          <>
            <OrgStatus status={org.status} />
            <span className="font-mono text-xs">{org.slug}</span>
          </>
        }
        actions={
          isAdmin ? (
            <Button asChild variant="outline">
              <Link to="/admin/platform/orgs/$orgId" params={{ orgId: org.id }}>
                Platform provisioning
              </Link>
            </Button>
          ) : undefined
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
          The displayed organization details may be out of date. Your unsaved changes are kept.
        </Callout>
      ) : null}
      <div className="flex min-w-0 flex-col gap-6">
        {org.status === 'suspended' ? (
          <Callout tone="warning">
            Suspended: passes do not update and its API keys do not work.
          </Callout>
        ) : null}
        <OrgFacts org={org} />
        {canManage ? <OrgForm org={org} canChooseIdentity={isAdmin} /> : null}
        <OrgSettingsSections
          orgId={org.id}
          canManage={canManage}
          sandbox={org.kind === 'developer'}
        />
        {canManage ? <DataCard orgId={org.id} /> : null}
      </div>
    </SaveBarGroup>
  );
}
