import { type InfiniteData, infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { OkSchema } from '@/shared/contracts/common.ts';
import {
  MyEmailListSchema,
  MyPassListSchema,
  MyPassSchema,
  MySessionListSchema,
  RefreshResponseSchema,
  RemovePassResponseSchema,
} from '@/shared/contracts/me.ts';
import { api } from '../lib/api.ts';
import { isPendingRefresh } from './refresh.ts';

export const myPassesKey = ['me', 'passes'] as const;
export const myEmailsKey = ['me', 'emails'] as const;
export const mySessionsKey = ['me', 'sessions'] as const;

const POLL_MS = 3000;
const MAX_REMOVAL_POLL_MS = 60_000;

type Page = typeof MyPassListSchema._output;

const pendingRefresh = (pages: InfiniteData<Page> | undefined, now: number): boolean =>
  pages?.pages.some((p) => p.items.some((pass) => isPendingRefresh(pass, now))) ?? false;

const pendingRemoval = (pages: InfiniteData<Page> | undefined): boolean =>
  pages?.pages.some((p) => p.pendingRemovals.length > 0) ?? false;

/**
 * A refresh is quick, so it polls every 3 s while it lasts. A removal waits on wallets and can
 * take hours: each poll waits half as long again, up to a minute.
 */
export function pollDelay(
  pages: InfiniteData<Page> | undefined,
  polls: number,
  now = Date.now(),
): number | false {
  if (pendingRefresh(pages, now)) return POLL_MS;
  if (!pendingRemoval(pages)) return false;
  return Math.min(POLL_MS * 1.5 ** Math.max(0, polls - 1), MAX_REMOVAL_POLL_MS);
}

export const myPassesQuery = infiniteQueryOptions({
  queryKey: myPassesKey,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam, signal }) =>
    api.get('/api/v1/me/passes', MyPassListSchema, { query: { cursor: pageParam }, signal }),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  refetchInterval: (query) => pollDelay(query.state.data, query.state.dataUpdateCount),
});

export function myPassQuery(id: string) {
  return queryOptions({
    queryKey: [...myPassesKey, id] as const,
    queryFn: ({ signal }) =>
      api.get(`/api/v1/me/passes/${encodeURIComponent(id)}`, MyPassSchema, { signal }),
    refetchInterval: (query) =>
      query.state.data && isPendingRefresh(query.state.data, Date.now()) ? POLL_MS : false,
  });
}

export const fetchMyEmails = (signal?: AbortSignal) =>
  api.get('/api/v1/me/emails', MyEmailListSchema, signal ? { signal } : {});

export const myEmailsQuery = queryOptions({
  queryKey: myEmailsKey,
  queryFn: ({ signal }) => fetchMyEmails(signal),
});

export const mySessionsQuery = queryOptions({
  queryKey: mySessionsKey,
  queryFn: ({ signal }) => api.get('/api/v1/me/sessions', MySessionListSchema, { signal }),
});

export const requestRefresh = (id: string) =>
  api.post(`/api/v1/me/passes/${encodeURIComponent(id)}/refresh`, RefreshResponseSchema);

export const removePass = (id: string) =>
  api.deleteJson(`/api/v1/me/passes/${encodeURIComponent(id)}`, RemovePassResponseSchema);

export const getMyRemoval = (transferId: string) =>
  api.get(`/api/v1/me/pass-removals/${encodeURIComponent(transferId)}`, RemovePassResponseSchema);

export const addEmail = (email: string) => api.post('/api/v1/me/emails', OkSchema, { email });

export const removeEmail = (email: string) =>
  api.delete(`/api/v1/me/emails/${encodeURIComponent(email)}`);

export const makePrimaryEmail = (email: string) =>
  api.post(`/api/v1/me/emails/${encodeURIComponent(email)}/primary`, MyEmailListSchema);

export const revokeSession = (id: string) =>
  api.delete(`/api/v1/me/sessions/${encodeURIComponent(id)}`);
