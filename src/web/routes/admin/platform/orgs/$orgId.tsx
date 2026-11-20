import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { OrgDetailPage } from '../../../../admin/orgs/org-detail.tsx';
import { useOrgScope } from '../../../../lib/org-filter.tsx';

/** Unknown or malformed values fall away instead of breaking the page. */
const searchSchema = z.object({
  tab: z.enum(['overview', 'features']).optional().catch(undefined),
});

export const Route = createFileRoute('/admin/platform/orgs/$orgId')({
  validateSearch: searchSchema,
  component: function OrgRoute() {
    const { orgId } = Route.useParams();
    const { tab } = Route.useSearch();
    const navigate = Route.useNavigate();
    const scope = useOrgScope();
    // The directory record; the organization's own console needs a membership.
    const canOpenWorkspace = scope.memberships.some(
      (membership) => membership.orgId === orgId && membership.capabilities.includes('org:read'),
    );
    return (
      <OrgDetailPage
        orgId={orgId}
        canOpenWorkspace={canOpenWorkspace}
        tab={tab ?? 'overview'}
        onTab={(next) =>
          void navigate({
            search: (prev) => ({ ...prev, tab: next === 'overview' ? undefined : next }),
            replace: true,
          })
        }
      />
    );
  },
});
