import { createFileRoute } from '@tanstack/react-router';
import { PlanPage } from '../../../../../admin/plan/plan-page.tsx';
import { useOrgScope, useResourceOrg } from '../../../../../lib/org-filter.tsx';
import { DetailNotFound, SkeletonDetail } from '../../../../../ui/index.ts';

export const Route = createFileRoute('/admin/o/$orgId/plan/')({
  component: function OrgPlanRoute() {
    const { orgId } = Route.useParams();
    const { membership } = useOrgScope();
    const resource = useResourceOrg(orgId);
    if (resource === 'not-found' || resource === 'choose-org') {
      return <DetailNotFound entity="org" to="/admin" back="Overview" heading />;
    }
    if (resource !== 'ready' || !membership) return <SkeletonDetail label="Loading organization" />;
    return <PlanPage key={orgId} orgId={orgId} membership={membership} />;
  },
});
