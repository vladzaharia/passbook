import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ApiKeyActivitySchema,
  ApiKeyDetailSchema,
  ApiKeyListSchema,
  ApiKeySchema,
  CreatedApiKeySchema,
} from '@/shared/contracts/api-keys.ts';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import { useToolApi, useToolScope } from '@/web/lib/tool-api.tsx';
import { type ApiKey, useKeysRoot } from './queries.ts';

// A first call returns the secret; the console never sends an Idempotency-Key, so it never sees a replay.
const RotatedSchema = z.object({ key: CreatedApiKeySchema, previous: ApiKeySchema });
export type ApiKeyDetail = z.infer<typeof ApiKeyDetailSchema>;
export type ApiKeyActivity = z.infer<typeof ApiKeyActivitySchema>;

const scopeQuery = (orgId: string | null) => ({ orgId: orgId ?? 'null' });
const path = (id: string, rest = '') => `/api/v1/api-keys/${encodeURIComponent(id)}${rest}`;

export function useKeyDetail(principal: string, orgId: string | null, id: string) {
  const api = useToolApi();
  const root = useKeysRoot();
  return useQuery({
    queryKey: [...root, principal, 'detail', orgId, id],
    queryFn: ({ signal }) =>
      api.get(path(id), ApiKeyDetailSchema, { query: scopeQuery(orgId), signal }),
  });
}

/** The keys this key minted, newest first. */
export function useKeyChildren(principal: string, orgId: string | null, parent: string) {
  const api = useToolApi();
  const root = useKeysRoot();
  return useQuery({
    queryKey: [...root, principal, 'children', orgId, parent],
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
  const api = useToolApi();
  const root = useKeysRoot();
  return useQuery({
    enabled,
    queryKey: [...root, principal, 'activity', orgId, id],
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
  const api = useToolApi();
  const root = useKeysRoot();
  const hosted = useToolScope() !== null;
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
        RotatedSchema,
        { orgId: key.orgId, overlapHours },
        hosted ? undefined : { headers: { [MODE_HEADER]: key.mode } },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: [...root, principal] }),
  });
}
