import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import type { BroadcastState } from '@/shared/contracts/broadcasts.ts';
import { MessagesPage } from '../../../admin/messages/messages-page.tsx';
import { compactSearch } from '../../../lib/url-state.ts';

const searchSchema = z.object({
  // Narrowed here by name only: the full contract stays out of the entry chunk.
  state: z
    .enum([
      'draft',
      'scheduled',
      'sending',
      'sent',
      'partial',
      'failed',
      'cancelled',
    ] as const satisfies readonly BroadcastState[])
    .optional()
    .catch(undefined),
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
