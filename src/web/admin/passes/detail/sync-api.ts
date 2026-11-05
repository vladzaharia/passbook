import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  type EventGroup,
  PassDevicesSchema,
  PassEventListSchema,
} from '@/shared/contracts/events.ts';
import { api } from '../../../lib/api.ts';

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
    // A filter change keeps the old rows on screen, dimmed, under the loading rail.
    placeholderData: keepPreviousData,
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
