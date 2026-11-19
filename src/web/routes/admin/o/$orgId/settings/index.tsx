import { createFileRoute } from '@tanstack/react-router';
import { OrgWorkspacePage } from '../../../../../admin/orgs/org-workspace.tsx';
import { useOrgScope } from '../../../../../lib/org-filter.tsx';
import { useSession } from '../../../../../lib/session.ts';

export const Route = createFileRoute('/admin/o/$orgId/settings/')({
  // The org gate admits this page only with an org:read membership in the path's organization.
  component: function OrgSettingsRoute() {
    const { orgId } = Route.useParams();
    const { membership } = useOrgScope();
    const { isAdmin } = useSession();
    if (!membership) return null;
    return <OrgWorkspacePage orgId={orgId} membership={membership} isAdmin={isAdmin} />;
  },
});
