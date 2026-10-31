import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage, parseOverviewSearch } from '../../admin/overview/overview-page.tsx';

export const Route = createFileRoute('/admin/')({
  validateSearch: parseOverviewSearch,
  component: function OverviewRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <OverviewPage
        search={search}
        onSearch={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});
