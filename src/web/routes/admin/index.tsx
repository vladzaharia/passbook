import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { OverviewPage } from '../../admin/overview/overview-page.tsx';
import { parseOverviewSearch } from '../../admin/overview/overview-search.ts';

export const Route = createFileRoute('/admin/')({
  validateSearch: parseOverviewSearch,
  component: function OverviewRoute() {
    const search = Route.useSearch();
    const filterOrgId = useRouterState({
      select: (state) => {
        const values = new URLSearchParams(state.location.searchStr).getAll('filterOrgId');
        const parsed = state.location.search.filterOrgId;
        const candidate =
          typeof parsed === 'string'
            ? parsed
            : parsed == null || typeof parsed === 'number' || typeof parsed === 'boolean'
              ? values[0]
              : undefined;
        return values.length === 1 && candidate?.trim() ? candidate.trim() : undefined;
      },
    });
    const navigate = Route.useNavigate();
    return (
      <OverviewPage
        search={{ ...search, filterOrgId }}
        onSearch={(next) =>
          void navigate({
            search: (previous) => ({ ...previous, filterOrgId, ...next }),
            replace: true,
          })
        }
      />
    );
  },
});
