import { createFileRoute } from '@tanstack/react-router';
import { parseUsersSearch, UsersPage } from '../../../admin/users/users-page.tsx';

export const Route = createFileRoute('/admin/users/')({
  validateSearch: parseUsersSearch,
  component: function UsersRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <UsersPage
        search={search}
        onSearch={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});
