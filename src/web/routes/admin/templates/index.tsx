import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { TemplatesListPage } from '../../../admin/templates/list-page.tsx';
import { compactSearch } from '../../../lib/url-state.ts';

const searchSchema = z.object({
  origin: z.enum(['baked', 'uploaded']).optional().catch(undefined),
  orgId: z.string().optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
});

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
  validateSearch: searchSchema,
  component: TemplatesRoute,
});
