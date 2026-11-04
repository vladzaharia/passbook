import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import {
  BroadcastListSchema,
  BroadcastPreviewSchema,
  BroadcastSchema,
  type BroadcastState,
  type BroadcastTarget,
  type CreateBroadcastSchema,
} from '@/shared/contracts/broadcasts.ts';
import { api, listQuery } from '../../lib/api.ts';

export interface BroadcastFilters {
  orgId?: string | undefined;
  state?: BroadcastState | undefined;
}

export const broadcastKeys = {
  all: ['admin', 'broadcasts'] as const,
  list: (f: BroadcastFilters) => ['admin', 'broadcasts', 'pages', f] as const,
  detail: (id: string) => ['admin', 'broadcasts', 'detail', id] as const,
};

/** The Messages list: 50 at a time. Refreshes while something is on its way out. */
export function useBroadcastPages(filters: BroadcastFilters) {
  return useInfiniteQuery(
    listQuery({
      queryKey: broadcastKeys.list(filters),
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get('/api/v1/broadcasts', BroadcastListSchema, {
          query: { ...filters, cursor: pageParam, limit: 50 },
          signal,
        }),
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
      refetchInterval: (query: {
        state: { data?: { pages: { items: { state: string }[] }[] } | undefined };
      }) =>
        query.state.data?.pages.some((p) => p.items.some((b) => b.state === 'sending'))
          ? 3000
          : false,
    }),
  );
}

/** Polls while the message is sending or waiting on its time. */
export const broadcastQuery = (id: string) =>
  queryOptions({
    queryKey: broadcastKeys.detail(id),
    queryFn: ({ signal }) => api.get(`/api/v1/broadcasts/${id}`, BroadcastSchema, { signal }),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'sending' ? 2000 : state === 'scheduled' ? 30_000 : false;
    },
  });

export function useBroadcast(id: string | undefined) {
  return useQuery({ ...broadcastQuery(id ?? ''), enabled: Boolean(id) });
}

export type NewBroadcast = z.input<typeof CreateBroadcastSchema>;

export function useBroadcastActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: broadcastKeys.all });
  return {
    create: useMutation({
      mutationFn: (body: NewBroadcast) => api.post('/api/v1/broadcasts', BroadcastSchema, body),
      onSuccess: async (made) => {
        qc.setQueryData(broadcastKeys.detail(made.id), made);
        await done();
      },
    }),
    cancel: useMutation({
      mutationFn: (id: string) => api.post(`/api/v1/broadcasts/${id}/cancel`, BroadcastSchema),
      onSuccess: done,
    }),
  };
}

/** How many passes the audience matches now, and how many are at their daily push limit. */
export function useAudienceCount(orgId: string | undefined, target: BroadcastTarget | undefined) {
  return useQuery({
    queryKey: ['admin', 'broadcasts', 'preview', orgId, target],
    queryFn: ({ signal }) =>
      api.post('/api/v1/broadcasts/preview', BroadcastPreviewSchema, { orgId, target }, { signal }),
    enabled: Boolean(orgId && target),
    staleTime: 10_000,
    placeholderData: (previous) => previous,
  });
}
