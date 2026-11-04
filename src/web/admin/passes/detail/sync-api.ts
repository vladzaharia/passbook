import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type EventGroup,
  PassDevicesSchema,
  PassEventListSchema,
} from '@/shared/contracts/events.ts';
import { PassActionResponseSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../../lib/api.ts';
import { passKeys } from '../api.ts';

const POLL_MS = 15_000;

export const syncKeys = {
  devices: (id: string) => ['admin', 'passes', 'devices', id] as const,
  events: (id: string, group: EventGroup | 'all') =>
    ['admin', 'passes', 'events', id, group] as const,
};

/** Devices with their sync status; polls while the tab is open so a fetch shows up. */
export function usePassDevices(id: string, active: boolean) {
  return useQuery({
    queryKey: syncKeys.devices(id),
    queryFn: ({ signal }) => api.get(`/api/v1/passes/${id}/devices`, PassDevicesSchema, { signal }),
    refetchInterval: active ? POLL_MS : false,
  });
}

/** The ledger newest first, a page at a time; the first page refreshes while the tab is open. */
export function usePassEvents(id: string, group: EventGroup | 'all', active: boolean) {
  return useInfiniteQuery({
    queryKey: syncKeys.events(id, group),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/v1/passes/${id}/events`, PassEventListSchema, {
        query: { limit: 50, ...(group === 'all' ? {} : { group }), cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Refetching reloads every loaded page, so polling stops once older pages are open.
    refetchInterval: (query) =>
      active && (query.state.data?.pages.length ?? 1) <= 1 ? POLL_MS : false,
  });
}

/** Remove from Wallet and its undo; both end by refetching the pass, its devices and its log. */
export function usePassRemoval(id: string) {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: passKeys.all });
  };
  return {
    remove: useMutation({
      mutationFn: (message: string | undefined) =>
        api.post(`/api/v1/passes/${id}/remove`, PassActionResponseSchema, { message }),
      onSuccess: refresh,
    }),
    restore: useMutation({
      mutationFn: () => api.post(`/api/v1/passes/${id}/restore`, PassActionResponseSchema),
      onSuccess: refresh,
    }),
  };
}
