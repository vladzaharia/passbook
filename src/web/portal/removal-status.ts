import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { MyPassListSchema } from '@/shared/contracts/me.ts';
import { sessionQuery } from '../lib/session.ts';
import { toast } from '../ui/index.ts';
import { getMyRemoval } from './api.ts';

type Pending = (typeof MyPassListSchema._output)['pendingRemovals'];

/** A missing pending row is not proof of completion: consult the requester's receipt. */
export function useRemovalStatus(pending: Pending | undefined) {
  const client = useQueryClient();
  const previous = useRef<{ userId: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!pending) return;
    const currentUser = () => {
      const state = client.getQueryState(sessionQuery.queryKey);
      return state?.status === 'success' && state.data?.authenticated
        ? state.data.user.id
        : undefined;
    };
    const userId = currentUser();
    if (!userId) {
      previous.current = null;
      return;
    }
    const ids = new Set(pending.map((item) => item.transferId));
    const prior = previous.current?.userId === userId ? previous.current.ids : new Set<string>();
    previous.current = { userId, ids };
    for (const id of prior) {
      if (ids.has(id)) continue;
      void getMyRemoval(id)
        .then((result) => {
          if (
            currentUser() === userId &&
            result.transferId === id &&
            result.state === 'completed'
          ) {
            toast.success('Removed from your passes');
          }
        })
        .catch((error: unknown) => {
          if (currentUser() === userId) toast.error(error, 'Could not confirm pass removal');
        });
    }
  }, [client, pending]);
}
