import { createFileRoute } from '@tanstack/react-router';
import { UserDetailPage } from '../../../admin/users/user-detail.tsx';

export const Route = createFileRoute('/admin/users/$userId')({
  component: function UserRoute() {
    const { userId } = Route.useParams();
    return <UserDetailPage userId={userId} />;
  },
});
