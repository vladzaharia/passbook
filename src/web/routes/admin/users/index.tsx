import { createFileRoute } from '@tanstack/react-router';
import { UsersPage } from '../../../admin/users/users-page.tsx';
import { parseUsersSearch } from '../../../admin/users/users-search.ts';
import { UNSCOPED_SEARCH } from '../../../lib/org-filter.tsx';

export const Route = createFileRoute('/admin/users/')({
  search: UNSCOPED_SEARCH,
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
