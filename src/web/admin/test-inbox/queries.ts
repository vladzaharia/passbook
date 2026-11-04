import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import {
  CapturedEmailDetailSchema,
  CapturedEmailListSchema,
  SentToMeSchema,
} from '@/shared/contracts/sandbox.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';

export const inboxKeys = { all: ['test-inbox'] as const };

const path = (id: string) => `/api/v1/test-inbox/${encodeURIComponent(id)}`;

export function useCapturedEmails(orgId: string | undefined) {
  const mode = useMode();
  return useInfiniteQuery({
    queryKey: [...inboxKeys.all, 'list', orgId ?? null],
    enabled: mode === 'test',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/test-inbox', CapturedEmailListSchema, {
        query: { orgId, cursor: pageParam, limit: 50 },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useCapturedEmail(id: string | undefined) {
  return useQuery({
    queryKey: [...inboxKeys.all, 'detail', id ?? null],
    enabled: id !== undefined,
    queryFn: ({ signal }) => api.get(path(id ?? ''), CapturedEmailDetailSchema, { signal }),
  });
}

export function useSendToMe() {
  return useMutation({
    mutationFn: (id: string) => api.post(`${path(id)}/send-to-me`, SentToMeSchema),
  });
}
