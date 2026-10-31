import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { ConnectionsListPage } from '../../../admin/connections/list-page.tsx';
import { compactSearch } from '../../../lib/url-state.ts';

const searchSchema = z.object({
  orgId: z.string().optional().catch(undefined),
  health: z.string().optional().catch(undefined),
});

function ConnectionsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ search: (prev) => compactSearch({ ...prev, ...patch }), replace: true }),
    [navigate],
  );
  return <ConnectionsListPage search={search} onSearch={onSearch} />;
}

export const Route = createFileRoute('/admin/connections/')({
  validateSearch: searchSchema,
  component: ConnectionsRoute,
});
