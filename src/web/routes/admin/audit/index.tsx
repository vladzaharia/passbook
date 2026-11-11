import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { AuditPage } from '../../../admin/audit/audit-page.tsx';
import { parseAuditSearch } from '../../../admin/audit/audit-search.ts';

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
    return (
      <AuditPage
        search={{ ...search, filterOrgId, targetId }}
        onSearch={(next) => void navigate({ search: next })}
      />
    );
  },
});
