import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { OrgOverviewPage } from '../../admin/overview/org-overview.tsx';
import { OverviewPage } from '../../admin/overview/overview-page.tsx';
import { parseOverviewSearch } from '../../admin/overview/overview-search.ts';
import { useSession } from '../../lib/session.ts';

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
    const { isAdmin } = useSession();
    // A platform admin sees the platform; a member sees their organization.
    const Page = isAdmin ? OverviewPage : OrgOverviewPage;
    return (
      <Page
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
