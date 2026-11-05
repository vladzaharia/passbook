import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import {
  BroadcastListSchema,
  BroadcastPreviewSchema,
  BroadcastSchema,
  type BroadcastState,
  type BroadcastTarget,
  type CreateBroadcastSchema,
} from '@/shared/contracts/broadcasts.ts';
import { IdSchema, pageOf } from '@/shared/contracts/common.ts';
import { api, listQuery } from '../../lib/api.ts';

const path = (id: string) => `/api/v1/broadcasts/${encodeURIComponent(id)}`;

export const ITEM_OUTCOMES = ['updated', 'unchanged', 'failed'] as const;
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];

/** One pass a run handled (GET /broadcasts/:id/items). */
export const BroadcastItemSchema = z.object({
  passId: IdSchema,
  holder: z.string().nullable().optional(),
  outcome: z.enum(ITEM_OUTCOMES),
  /** Updated without a notification: the pass was at its daily limit. */
  silent: z.boolean(),
});
export type BroadcastItem = z.infer<typeof BroadcastItemSchema>;
const BroadcastItemListSchema = pageOf(BroadcastItemSchema);

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
    queryFn: ({ signal }) => api.get(path(id), BroadcastSchema, { signal }),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'sending' ? 2000 : state === 'scheduled' ? 30_000 : false;
    },
  });

/** The passes a run handled, newest outcome filter first; polls while the run is going. */
export function useBroadcastItems(id: string, outcome: ItemOutcome | undefined, live: boolean) {
  return useInfiniteQuery({
    queryKey: [...broadcastKeys.detail(id), 'items', outcome ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(`${path(id)}/items`, BroadcastItemListSchema, {
        query: { outcome, cursor: pageParam, limit: 25 },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: live ? 4000 : false,
  });
}

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
    /** Replaces a draft's contents. */
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: NewBroadcast }) =>
        api.patch(path(id), BroadcastSchema, body),
      onSuccess: async (made) => {
        qc.setQueryData(broadcastKeys.detail(made.id), made);
        await done();
      },
    }),
    /** Sends a draft now (no `at`) or at a time. */
    send: useMutation({
      mutationFn: ({ id, at }: { id: string; at?: number | undefined }) =>
        api.post(`${path(id)}/send`, BroadcastSchema, at === undefined ? {} : { at }),
      onSuccess: async (made) => {
        qc.setQueryData(broadcastKeys.detail(made.id), made);
        await done();
      },
    }),
    cancel: useMutation({
      mutationFn: (id: string) => api.post(`${path(id)}/cancel`, BroadcastSchema),
      onSuccess: done,
    }),
    /** Copies a failed message into a new one in its own mode and sends it. */
    retry: useMutation({
      mutationFn: (id: string) => api.post(`${path(id)}/retry`, BroadcastSchema),
      onSuccess: async (made) => {
        qc.setQueryData(broadcastKeys.detail(made.id), made);
        await done();
      },
    }),
  };
}

/** How many passes the audience matches now, and how many are at their daily push limit. */
export function useAudienceCount(
  orgId: string | undefined,
  target: BroadcastTarget | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['admin', 'broadcasts', 'preview', orgId, target],
    queryFn: ({ signal }) =>
      api.post('/api/v1/broadcasts/preview', BroadcastPreviewSchema, { orgId, target }, { signal }),
    enabled: enabled && Boolean(orgId && target),
    staleTime: 10_000,
    placeholderData: (previous) => previous,
  });
}
