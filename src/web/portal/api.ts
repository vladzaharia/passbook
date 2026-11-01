import { type InfiniteData, infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { OkSchema } from '@/shared/contracts/common.ts';
import {
  MyEmailListSchema,
  MyPassListSchema,
  MyPassSchema,
  MySessionListSchema,
  RefreshResponseSchema,
} from '@/shared/contracts/me.ts';
import { api } from '../lib/api.ts';
import { isPendingRefresh } from './refresh.ts';

export const myPassesKey = ['me', 'passes'] as const;
export const myEmailsKey = ['me', 'emails'] as const;
export const mySessionsKey = ['me', 'sessions'] as const;

const POLL_MS = 3000;

type Page = typeof MyPassListSchema._output;

export function anyPending(pages: InfiniteData<Page> | undefined, now = Date.now()): boolean {
  return pages?.pages.some((p) => p.items.some((pass) => isPendingRefresh(pass, now))) ?? false;
}

export const myPassesQuery = infiniteQueryOptions({
  queryKey: myPassesKey,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam, signal }) =>
    api.get('/api/v1/me/passes', MyPassListSchema, { query: { cursor: pageParam }, signal }),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
  refetchInterval: (query) => (anyPending(query.state.data) ? POLL_MS : false),
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

export const removePass = (id: string) => api.delete(`/api/v1/me/passes/${encodeURIComponent(id)}`);

export const addEmail = (email: string) => api.post('/api/v1/me/emails', OkSchema, { email });

export const removeEmail = (email: string) =>
  api.delete(`/api/v1/me/emails/${encodeURIComponent(email)}`);

export const makePrimaryEmail = (email: string) =>
  api.post(`/api/v1/me/emails/${encodeURIComponent(email)}/primary`, MyEmailListSchema);

export const revokeAllSessions = () => api.action('POST', '/api/v1/me/sessions/revoke-all');

export const revokeSession = (id: string) =>
  api.delete(`/api/v1/me/sessions/${encodeURIComponent(id)}`);
