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
import { api } from '@/web/lib/api.ts';

export type ApiKey = z.infer<typeof ApiKeySchema>;
type Page = z.infer<typeof ApiKeyListSchema>;
type KeyState = 'live' | 'revoked';
const KEYS = ['api-keys', 'context'] as const;

/** The explicit `null` query marker selects platform-wide keys, never all tenant keys. */
export function useApiKeyPages(
  principal: string,
  orgId: string | null,
  state: KeyState,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: [...KEYS, principal, orgId, state],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      api.get('/api/v1/api-keys', ApiKeyListSchema, {
        query: { orgId: orgId ?? 'null', state, cursor: pageParam, limit: 50 },
        signal,
      }),
    getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
  });
}

/**
 * A revoked key stays in place in the live list (marked revoked) until the list refetches; the
 * revoked list refetches when next shown.
 */
export function useRevokeKey(principal: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, orgId }: Pick<ApiKey, 'id' | 'orgId'>) =>
      api.delete(`/api/v1/api-keys/${encodeURIComponent(id)}`, {
        query: { orgId: orgId ?? 'null' },
      }),
    onSuccess: (_done, { id, orgId }) => {
      const at = Date.now();
      client.setQueryData<InfiniteData<Page>>(
        [...KEYS, principal, orgId, 'live'],
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
        queryKey: [...KEYS, principal, orgId, 'revoked'],
        exact: true,
      });
    },
  });
}

export function useCreateKey(principal: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof CreateApiKeySchema> & { orgId: string | null }) =>
      api.post('/api/v1/api-keys', CreatedApiKeySchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: [...KEYS, principal] }),
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
  'connections:read': 'Read connections',
  'connections:write': 'Create and update connections',
};
