import { createFileRoute } from '@tanstack/react-router';
import { UserDetailPage } from '../../../admin/users/user-detail.tsx';
import { UNSCOPED_SEARCH } from '../../../lib/org-filter.tsx';

export const Route = createFileRoute('/admin/users/$userId')({
  search: UNSCOPED_SEARCH,
  component: function UserRoute() {
    const { userId } = Route.useParams();
    return <UserDetailPage userId={userId} />;
  },
});
