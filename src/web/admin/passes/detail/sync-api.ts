import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  type EventGroup,
  PassDevicesSchema,
  PassEventListSchema,
} from '@/shared/contracts/events.ts';
import { pollEvery } from '../../../lib/poll-backoff.ts';
import { useToolApi, useToolKey } from '../../../lib/tool-api.tsx';

export const POLL_MS = 15_000;

/**
 * The pass trail, devices and versions are shared tools: admin's pass page and the Workbench's
 * inspector mount them. Every call goes through the tool scope (`lib/tool-api.tsx`), and the keys
 * carry the host's client, so a cached answer never crosses hosts.
 */
export const syncKeys = {
  /** Everything read for one pass: what a simulated event invalidates. */
  pass: (id: string) => ['admin', 'passes', 'sync', id] as const,
  devices: (id: string) => ['admin', 'passes', 'sync', id, 'devices'] as const,
  events: (id: string, group: EventGroup | 'all') =>
    ['admin', 'passes', 'sync', id, 'events', group] as const,
};

/** Devices with their sync status; polls while the tab is open so a fetch shows up. */
export function usePassDevices(id: string, active: boolean) {
  const api = useToolApi();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: [...syncKeys.devices(id), ...toolKey],
    queryFn: ({ signal }) => api.get(`/api/v1/passes/${id}/devices`, PassDevicesSchema, { signal }),
    refetchInterval: active ? pollEvery(POLL_MS) : false,
  });
}

/** The ledger newest first, a page at a time; the first page refreshes while the tab is open. */
export function usePassEvents(id: string, group: EventGroup | 'all', active: boolean) {
  const api = useToolApi();
  const toolKey = useToolKey();
  return useInfiniteQuery({
    queryKey: [...syncKeys.events(id, group), ...toolKey],
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
      active && (query.state.data?.pages.length ?? 1) <= 1 ? pollEvery(POLL_MS)(query) : false,
  });
}

const DiffSchema = z.object({
  changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
});

/** What changed between two retained versions. */
export function usePassDiff(id: string, from: number | undefined, to: number | undefined) {
  const api = useToolApi();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: ['admin', 'passes', 'diff', id, from, to, ...toolKey],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/${id}/diff`, DiffSchema, { query: { from, to }, signal }),
    enabled: from !== undefined && to !== undefined && from !== to,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
