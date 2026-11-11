import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { OrgDetailPage } from '../../../admin/orgs/org-detail.tsx';
import { OrgWorkspacePage } from '../../../admin/orgs/org-workspace.tsx';
import { useOrgScope, useResourceOrg } from '../../../lib/org-filter.tsx';
import { useSession } from '../../../lib/session.ts';
import { DetailNotFound, ErrorState, SkeletonDetail } from '../../../ui/index.ts';

function MemberOrgWorkspace({ orgId, isAdmin }: { orgId: string; isAdmin: boolean }) {
  const scope = useOrgScope();
  const resourceScope = useResourceOrg(orgId);
  if (scope.isLoading) return <SkeletonDetail label="Loading organization" />;
  if (scope.isError) {
    return (
      <ErrorState
        subject="organization access"
        error={scope.error}
        onRetry={() => scope.refetch()}
      />
    );
  }
  const actual = scope.memberships.find(
    (membership) => membership.orgId === orgId && membership.capabilities.includes('org:read'),
  );
  if (!actual || resourceScope === 'not-found') {
    return (
      <DetailNotFound
        entity="org"
        to={isAdmin ? '/admin/orgs' : '/admin/account'}
        back={isAdmin ? 'Organizations' : 'Account'}
        heading
      />
    );
  }
  if (resourceScope !== 'ready' || scope.membership?.orgId !== orgId) {
    return <SkeletonDetail label="Loading organization" />;
  }
  return <OrgWorkspacePage orgId={orgId} membership={scope.membership} isAdmin={isAdmin} />;
}

export const Route = createFileRoute('/admin/orgs/$orgId')({
  validateSearch: z.object({ view: z.literal('workspace').optional().catch(undefined) }),
  component: function OrgRoute() {
    const { orgId } = Route.useParams();
    const { view } = Route.useSearch();
    const { isAdmin } = useSession();
    const scope = useOrgScope();
    if (view === 'workspace') return <MemberOrgWorkspace orgId={orgId} isAdmin={isAdmin} />;
    if (!isAdmin) return <DetailNotFound entity="org" to="/admin/account" back="Account" heading />;
    const canOpenWorkspace = scope.memberships.some(
      (membership) => membership.orgId === orgId && membership.capabilities.includes('org:read'),
    );
    return <OrgDetailPage orgId={orgId} canOpenWorkspace={canOpenWorkspace} />;
  },
});
