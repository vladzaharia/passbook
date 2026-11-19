import { createFileRoute } from '@tanstack/react-router';
import { OrgDetailPage } from '../../../../admin/orgs/org-detail.tsx';
import { useOrgScope } from '../../../../lib/org-filter.tsx';

export const Route = createFileRoute('/admin/platform/orgs/$orgId')({
  component: function OrgRoute() {
    const { orgId } = Route.useParams();
    const scope = useOrgScope();
    // The directory record; the organization's own console needs a membership.
    const canOpenWorkspace = scope.memberships.some(
      (membership) => membership.orgId === orgId && membership.capabilities.includes('org:read'),
    );
    return <OrgDetailPage orgId={orgId} canOpenWorkspace={canOpenWorkspace} />;
  },
});
