import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { OkSchema } from '@/shared/contracts/common.ts';
import {
  MyEmailListSchema,
  MyPassListSchema,
  MyPassSchema,
  MySessionListSchema,
  RefreshResponseSchema,
  RemovePassStartedSchema,
  ResendResponseSchema,
} from '@/shared/contracts/me.ts';
import { api, PAGE_FETCH_TIMEOUT_MS } from '../lib/api.ts';

export const myPassesKey = ['me', 'passes'] as const;
export const myEmailsKey = ['me', 'emails'] as const;
export const mySessionsKey = ['me', 'sessions'] as const;

export const myPassesQuery = infiniteQueryOptions({
  queryKey: myPassesKey,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam, signal }) =>
    api.get('/api/v1/me/passes', MyPassListSchema, { query: { cursor: pageParam }, signal }),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
});

export function myPassQuery(id: string) {
  return queryOptions({
    queryKey: [...myPassesKey, id] as const,
    queryFn: ({ signal }) =>
      api.get(`/api/v1/me/passes/${encodeURIComponent(id)}`, MyPassSchema, {
        signal,
        timeoutMs: PAGE_FETCH_TIMEOUT_MS,
      }),
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

export const resendPass = (id: string) =>
  api.post(`/api/v1/me/passes/${encodeURIComponent(id)}/resend`, ResendResponseSchema);

export const lostPhone = (id: string) =>
  api.post(`/api/v1/me/passes/${encodeURIComponent(id)}/lost-phone`, RemovePassStartedSchema);

export const removePass = (id: string) =>
  api.deleteJson(`/api/v1/me/passes/${encodeURIComponent(id)}`, RemovePassStartedSchema);

export const addEmail = (email: string) => api.post('/api/v1/me/emails', OkSchema, { email });

export const removeEmail = (email: string) =>
  api.delete(`/api/v1/me/emails/${encodeURIComponent(email)}`);

export const makePrimaryEmail = (email: string) =>
  api.post(`/api/v1/me/emails/${encodeURIComponent(email)}/primary`, MyEmailListSchema);

export const revokeSession = (id: string) =>
  api.delete(`/api/v1/me/sessions/${encodeURIComponent(id)}`);

export const reportTagLost = (id: string) =>
  api.post(`/api/v1/me/tags/${encodeURIComponent(id)}/lost`, OkSchema);
