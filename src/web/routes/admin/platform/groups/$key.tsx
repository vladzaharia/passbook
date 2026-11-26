import { createFileRoute } from '@tanstack/react-router';
import { GroupDetailPage } from '../../../../admin/platform/groups/group-detail-page.tsx';

export const Route = createFileRoute('/admin/platform/groups/$key')({
  component: function GroupRoute() {
    const { key } = Route.useParams();
    return <GroupDetailPage groupKey={key} />;
  },
});
