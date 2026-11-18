import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { AuditPage } from '../../../admin/audit/audit-page.tsx';
import { parseAuditSearch } from '../../../admin/audit/audit-search.ts';
import { OrgAuditPage } from '../../../admin/audit/org-audit-page.tsx';
import { useSession } from '../../../lib/session.ts';

function urlId(search: string, key: string, parsed: unknown): string | undefined {
  const values = new URLSearchParams(search).getAll(key);
  const candidate =
    typeof parsed === 'string'
      ? parsed
      : parsed == null || typeof parsed === 'number' || typeof parsed === 'boolean'
        ? values[0]
        : undefined;
  return values.length === 1 && candidate?.trim() ? candidate.trim() : undefined;
}

export const Route = createFileRoute('/admin/audit/')({
  validateSearch: parseAuditSearch,
  component: function AuditRoute() {
    const search = Route.useSearch();
    const filterOrgId = useRouterState({
      select: (state) =>
        urlId(state.location.searchStr, 'filterOrgId', state.location.search.filterOrgId),
    });
    const targetId = useRouterState({
      select: (state) =>
        urlId(state.location.searchStr, 'targetId', state.location.search.targetId),
    });
    const navigate = Route.useNavigate();
    const { isAdmin } = useSession();
    // A member's log is their organization's; the route keeps its orgId across filter changes.
    const Page = isAdmin ? AuditPage : OrgAuditPage;
    return (
      <Page
        search={{ ...search, filterOrgId, targetId }}
        onSearch={(next) =>
          void navigate({ search: isAdmin ? next : (prev) => ({ ...next, orgId: prev.orgId }) })
        }
      />
    );
  },
});
