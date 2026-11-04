import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import {
  ApiKeyListSchema,
  type ApiKeySchema,
  type CreateApiKeySchema,
  CreatedApiKeySchema,
} from '@/shared/contracts/api-keys.ts';
import { api, listQuery } from '@/web/lib/api.ts';

export type ApiKey = z.infer<typeof ApiKeySchema>;
type Page = z.infer<typeof ApiKeyListSchema>;
type KeyState = 'live' | 'revoked';
const KEYS = ['api-keys'] as const;

/** Newest first, 50 at a time, for the top-bar org (platform keys only when unscoped). */
export function useApiKeyPages(orgId: string | undefined, state: KeyState, enabled = true) {
  return useInfiniteQuery(
    listQuery({
      queryKey: [...KEYS, orgId ?? null, state],
      enabled,
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get('/api/v1/api-keys', ApiKeyListSchema, {
          query: { orgId, state, cursor: pageParam, limit: 50 },
          signal,
        }),
      getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
    }),
  );
}

/**
 * A revoked key stays in place in the live list (marked revoked) until the list refetches; the
 * revoked list refetches when next shown.
 */
export function useRevokeKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/api-keys/${encodeURIComponent(id)}`),
    onSuccess: (_done, id) => {
      const at = Date.now();
      client.setQueriesData<InfiniteData<Page>>(
        { queryKey: KEYS, predicate: (q) => q.queryKey[2] === 'live' },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              items: p.items.map((k) => (k.id === id ? { ...k, revokedAt: at } : k)),
            })),
          },
      );
      void client.invalidateQueries({
        queryKey: KEYS,
        predicate: (q) => q.queryKey[2] === 'revoked',
      });
    },
  });
}

export function useCreateKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof CreateApiKeySchema>) =>
      api.post('/api/v1/api-keys', CreatedApiKeySchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: KEYS }),
  });
}

export function keyState(key: ApiKey, now: number): 'revoked' | 'expired' | 'active' {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && key.expiresAt <= now) return 'expired';
  return 'active';
}

/** Plain scope labels; the id stays beside them in mono. */
export const SCOPE_LABEL: Record<string, string> = {
  'passes:read': 'Read passes',
  'passes:write': 'Create and update passes',
  'holders:write': 'Assign holders',
  'templates:read': 'Read templates',
  'messages:write': 'Send messages and scheduled changes',
};
