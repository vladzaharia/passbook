import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  ApiKeyActivitySchema,
  ApiKeyDetailSchema,
  ApiKeyListSchema,
  RotatedApiKeySchema,
} from '@/shared/contracts/api-keys.ts';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import { api } from '@/web/lib/api.ts';
import type { ApiKey } from './queries.ts';

export type ApiKeyDetail = z.infer<typeof ApiKeyDetailSchema>;
export type ApiKeyActivity = z.infer<typeof ApiKeyActivitySchema>;

const root = (principal: string) => ['api-keys', 'context', principal] as const;
const scopeQuery = (orgId: string | null) => ({ orgId: orgId ?? 'null' });
const path = (id: string, rest = '') => `/api/v1/api-keys/${encodeURIComponent(id)}${rest}`;

export function useKeyDetail(principal: string, orgId: string | null, id: string) {
  return useQuery({
    queryKey: [...root(principal), 'detail', orgId, id],
    queryFn: ({ signal }) =>
      api.get(path(id), ApiKeyDetailSchema, { query: scopeQuery(orgId), signal }),
  });
}

/** The keys this key minted, newest first. */
export function useKeyChildren(principal: string, orgId: string | null, parent: string) {
  return useQuery({
    queryKey: [...root(principal), 'children', orgId, parent],
    queryFn: ({ signal }) =>
      api.get('/api/v1/api-keys', ApiKeyListSchema, {
        query: { ...scopeQuery(orgId), parentKeyId: parent, limit: 50 },
        signal,
      }),
  });
}

export function useKeyActivity(
  principal: string,
  orgId: string | null,
  id: string,
  enabled: boolean,
) {
  return useQuery({
    enabled,
    queryKey: [...root(principal), 'activity', orgId, id],
    queryFn: ({ signal }) =>
      api.get(path(id, '/activity'), ApiKeyActivitySchema, {
        query: { ...scopeQuery(orgId), limit: 20 },
        signal,
      }),
  });
}

/** Replaces a key. The request's mode is the key's, as the server mints the successor in it. */
export function useRotateKey(principal: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      overlapHours,
    }: {
      key: Pick<ApiKey, 'id' | 'orgId' | 'mode'>;
      overlapHours: number;
    }) =>
      api.post(
        path(key.id, '/rotate'),
        RotatedApiKeySchema,
        { orgId: key.orgId, overlapHours },
        { headers: { [MODE_HEADER]: key.mode } },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: root(principal) }),
  });
}
