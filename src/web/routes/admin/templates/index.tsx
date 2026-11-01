import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { TemplatesListPage } from '../../../admin/templates/list-page.tsx';
import { templateListSearchSchema } from '../../../admin/templates/search.ts';
import { compactSearch } from '../../../lib/url-state.ts';

function TemplatesRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ search: (prev) => compactSearch({ ...prev, ...patch }), replace: true }),
    [navigate],
  );
  return <TemplatesListPage search={search} onSearch={onSearch} />;
}

export const Route = createFileRoute('/admin/templates/')({
  validateSearch: templateListSearchSchema,
  component: TemplatesRoute,
});
