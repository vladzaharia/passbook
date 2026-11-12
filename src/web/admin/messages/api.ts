import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import type { z } from 'zod';
import {
  type BroadcastDto,
  type BroadcastItemDto,
  BroadcastItemListSchema,
  BroadcastListSchema,
  type BroadcastOutcome,
  BroadcastPreviewSchema,
  BroadcastSchema,
  type BroadcastState,
  type BroadcastTarget,
  type CreateBroadcastSchema,
} from '@/shared/contracts/broadcasts.ts';
import { api } from '../../lib/api.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { sessionQuery } from '../../lib/session.ts';

const path = (id: string) => `/api/v1/broadcasts/${encodeURIComponent(id)}`;

export type ItemOutcome = BroadcastOutcome;
/** One pass a run handled (GET /broadcasts/:id/items). */
export type BroadcastItem = BroadcastItemDto;

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
  const scope = useOrgScope();
  const orgId =
    !scope.isLoading &&
    !scope.isError &&
    filters.orgId &&
    filters.orgId === scope.orgId &&
    scope.membership?.capabilities.includes('messages:read')
      ? scope.orgId
      : undefined;
  const queryKey = orgId
    ? broadcastKeys.list({ ...filters, orgId })
    : ([...broadcastKeys.all, 'pages', null] as const);
  return useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => {
      if (!orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/broadcasts', BroadcastListSchema, {
        query: { ...filters, orgId, cursor: pageParam, limit: 50 },
        signal,
      });
    },
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    enabled: Boolean(orgId),
    placeholderData: (previous, query) =>
      orgId && query?.queryKey[3]?.orgId === orgId ? previous : undefined,
    refetchInterval: (query: {
      state: { data?: { pages: { items: { state: string }[] }[] } | undefined };
    }) =>
      query.state.data?.pages.some((p) => p.items.some((b) => b.state === 'sending'))
        ? 3000
        : false,
  });
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

export type NewBroadcast = z.input<typeof CreateBroadcastSchema>;

export function useBroadcastActions() {
  const qc = useQueryClient();
  const session = qc.getQueryData(sessionQuery.queryKey);
  const principalId = useRef(session?.authenticated ? session.user.id : undefined).current;
  const isCurrentPrincipal = () => {
    const current = qc.getQueryData(sessionQuery.queryKey);
    return Boolean(
      principalId &&
        qc.getQueryState(sessionQuery.queryKey)?.status === 'success' &&
        current?.authenticated &&
        current.user.id === principalId,
    );
  };
  const done = () =>
    isCurrentPrincipal() ? qc.invalidateQueries({ queryKey: broadcastKeys.all }) : undefined;
  const record = async (made: BroadcastDto) => {
    if (!isCurrentPrincipal()) return;
    qc.setQueryData(broadcastKeys.detail(made.id), made);
    await done();
  };
  return {
    create: useMutation({
      mutationFn: (body: NewBroadcast) => api.post('/api/v1/broadcasts', BroadcastSchema, body),
      onSuccess: record,
    }),
    /** Replaces a draft's contents. */
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: NewBroadcast }) =>
        api.patch(path(id), BroadcastSchema, body),
      onSuccess: record,
    }),
    /** Sends a draft now (no `at`) or at a time. */
    send: useMutation({
      mutationFn: ({ id, at }: { id: string; at?: number | undefined }) =>
        api.post(`${path(id)}/send`, BroadcastSchema, at === undefined ? {} : { at }),
      onSuccess: record,
    }),
    cancel: useMutation({
      mutationFn: (id: string) => api.post(`${path(id)}/cancel`, BroadcastSchema),
      onSuccess: done,
    }),
    /** Copies a failed message into a new one in its own mode and sends it. */
    retry: useMutation({
      mutationFn: (id: string) => api.post(`${path(id)}/retry`, BroadcastSchema),
      onSuccess: record,
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
