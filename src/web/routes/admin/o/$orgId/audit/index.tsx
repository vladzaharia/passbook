import { createFileRoute } from '@tanstack/react-router';
import { parseAuditSearch } from '../../../../../admin/audit/audit-search.ts';
import { OrgAuditPage } from '../../../../../admin/audit/org-audit-page.tsx';

export const Route = createFileRoute('/admin/o/$orgId/audit/')({
  validateSearch: parseAuditSearch,
  component: function OrgAuditRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return <OrgAuditPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});
