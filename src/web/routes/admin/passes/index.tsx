import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { PassesListPage } from '../../../admin/passes/list-page.tsx';
import { passListSearchSchema } from '../../../admin/passes/search.ts';
import { compactSearch } from '../../../lib/url-state.ts';

function PassesRoute() {
  // The scope is not a filter: the page reads it through useOrgScope.
  const { orgId: _scope, ...search } = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ search: (prev) => compactSearch({ ...prev, ...patch }), replace: true }),
    [navigate],
  );
  return <PassesListPage search={search} onSearch={onSearch} />;
}

export const Route = createFileRoute('/admin/passes/')({
  validateSearch: passListSearchSchema,
  component: PassesRoute,
});
