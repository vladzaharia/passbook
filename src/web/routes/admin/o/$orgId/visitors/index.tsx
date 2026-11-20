import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { VisitorsPage } from '../../../../../admin/visitors/visitors-page.tsx';
import { compactSearch } from '../../../../../lib/url-state.ts';

const searchSchema = z.object({
  tab: z
    .enum(['today', 'upcoming', 'past'] as const)
    .optional()
    .catch(undefined),
});

function VisitorsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ search: (prev) => compactSearch({ ...prev, ...patch }), replace: true }),
    [navigate],
  );
  return <VisitorsPage search={search} onSearch={onSearch} />;
}

export const Route = createFileRoute('/admin/o/$orgId/visitors/')({
  validateSearch: searchSchema,
  component: VisitorsRoute,
});
