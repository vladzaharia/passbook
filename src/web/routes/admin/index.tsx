import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '../../admin/overview/overview-page.tsx';
import { parseOverviewSearch } from '../../admin/overview/overview-search.ts';

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
