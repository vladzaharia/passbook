import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { BroadcastStateSchema } from '@/shared/contracts/broadcasts.ts';
import { MessagesPage } from '../../../admin/messages/messages-page.tsx';
import { compactSearch } from '../../../lib/url-state.ts';

const searchSchema = z.object({
  state: BroadcastStateSchema.optional().catch(undefined),
});

function MessagesRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ search: (prev) => compactSearch({ ...prev, ...patch }), replace: true }),
    [navigate],
  );
  return <MessagesPage search={search} onSearch={onSearch} />;
}

export const Route = createFileRoute('/admin/messages/')({
  validateSearch: searchSchema,
  component: MessagesRoute,
});
