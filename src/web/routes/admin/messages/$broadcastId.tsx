import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { MessageDetailPage } from '../../../admin/messages/detail-page.tsx';
import { compactSearch } from '../../../lib/url-state.ts';

const searchSchema = z.object({
  // Names the contract's outcomes; the full contract stays out of the entry chunk.
  outcome: z.enum(['updated', 'unchanged', 'failed']).optional().catch(undefined),
});

function MessageRoute() {
  const { broadcastId } = Route.useParams();
  const { outcome } = Route.useSearch();
  const navigate = Route.useNavigate();
  const onOutcome = useCallback(
    (next: typeof outcome) =>
      void navigate({
        search: (prev) => compactSearch({ ...prev, outcome: next }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  );
  return <MessageDetailPage broadcastId={broadcastId} outcome={outcome} onOutcome={onOutcome} />;
}

export const Route = createFileRoute('/admin/messages/$broadcastId')({
  validateSearch: searchSchema,
  component: MessageRoute,
});
