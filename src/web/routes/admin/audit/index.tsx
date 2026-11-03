import { createFileRoute } from '@tanstack/react-router';
import { AuditPage } from '../../../admin/audit/audit-page.tsx';
import { parseAuditSearch } from '../../../admin/audit/audit-search.ts';

export const Route = createFileRoute('/admin/audit/')({
  validateSearch: parseAuditSearch,
  component: function AuditRoute() {
    // `orgId` is the top-bar scope (useOrgScope), not one of the page's filters.
    const { orgId: _scope, ...search } = Route.useSearch();
    const navigate = Route.useNavigate();
    return <AuditPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});
