import { createFileRoute } from '@tanstack/react-router';
import { OrgWorkspacePage } from '../../../../../admin/orgs/org-workspace.tsx';
import { useOrgScope, useResourceOrg } from '../../../../../lib/org-filter.tsx';
import { useSession } from '../../../../../lib/session.ts';
import { DetailNotFound, SkeletonDetail } from '../../../../../ui/index.ts';

export const Route = createFileRoute('/admin/o/$orgId/settings/')({
  // The org gate admits an org:read membership; the workspace still waits for fresh grants.
  component: function OrgSettingsRoute() {
    const { orgId } = Route.useParams();
    const { membership } = useOrgScope();
    const { isAdmin } = useSession();
    const resource = useResourceOrg(orgId);
    if (resource === 'not-found' || resource === 'choose-org') {
      return <DetailNotFound entity="org" to="/admin" back="Overview" heading />;
    }
    if (resource !== 'ready' || !membership) return <SkeletonDetail label="Loading organization" />;
    return <OrgWorkspacePage key={orgId} orgId={orgId} membership={membership} isAdmin={isAdmin} />;
  },
});
