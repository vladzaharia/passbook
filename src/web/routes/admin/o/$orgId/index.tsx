import { createFileRoute } from '@tanstack/react-router';
import { OrgOverviewPage } from '../../../../admin/overview/org-overview.tsx';
import { parseOverviewSearch } from '../../../../admin/overview/overview-search.ts';

export const Route = createFileRoute('/admin/o/$orgId/')({
  validateSearch: parseOverviewSearch,
  component: function OrgOverviewRoute() {
    const { filterOrgId: _platformOnly, ...search } = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <OrgOverviewPage
        search={search}
        onSearch={(next) =>
          void navigate({ search: (previous) => ({ ...previous, ...next }), replace: true })
        }
      />
    );
  },
});
