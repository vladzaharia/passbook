import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  ApiKeyListSchema,
  type ApiKeySchema,
  type CreateApiKeySchema,
  CreatedApiKeySchema,
} from '@/shared/contracts/api-keys.ts';
import { api, listQuery } from '@/web/lib/api.ts';

export type ApiKey = z.infer<typeof ApiKeySchema>;
const KEYS = ['api-keys'] as const;

export function useApiKeys() {
  return useQuery(
    listQuery({
      queryKey: KEYS,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get('/api/v1/api-keys', ApiKeyListSchema, { signal }),
    }),
  );
}

export function useRevokeKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/api-keys/${encodeURIComponent(id)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: KEYS }),
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
};
