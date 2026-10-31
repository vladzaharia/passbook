import { createFileRoute } from '@tanstack/react-router';
import { OrgDetailPage } from '../../../admin/orgs/org-detail.tsx';

export const Route = createFileRoute('/admin/orgs/$orgId')({
  component: function OrgRoute() {
    const { orgId } = Route.useParams();
    return <OrgDetailPage orgId={orgId} />;
  },
});
