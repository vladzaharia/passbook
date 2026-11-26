import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import {
  ApiKeyListSchema,
  type ApiKeySchema,
  type CreateApiKeySchema,
  CreatedApiKeySchema,
} from '@/shared/contracts/api-keys.ts';
import { MODE_HEADER, pageOf } from '@/shared/contracts/common.ts';
import { ScannerKindSchema, ScannerSchema } from '@/shared/contracts/scanners.ts';
import { SCOPE_LABEL } from '@/shared/copy/api-key-scopes.ts';
import { useToolApi, useToolKey, useToolScope } from '@/web/lib/tool-api.tsx';

export type ApiKey = z.infer<typeof ApiKeySchema>;
type Page = z.infer<typeof ApiKeyListSchema>;
type KeyState = 'live' | 'revoked';
const BASE = ['api-keys', 'context'] as const;

/** The cache root: the host's client and mode follow `context`, so two clients never share an entry. */
export function useKeysRoot() {
  const tool = useToolKey();
  return [...BASE, ...tool] as const;
}

/** The explicit `null` query marker selects platform-wide keys, never all tenant keys. */
export function useApiKeyPages(
  principal: string,
  orgId: string | null,
  state: KeyState,
  enabled = true,
) {
  const api = useToolApi();
  const root = useKeysRoot();
  return useInfiniteQuery({
    queryKey: [...root, principal, orgId, state],
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
  const api = useToolApi();
  const root = useKeysRoot();
  return useMutation({
    mutationFn: ({ id, orgId }: Pick<ApiKey, 'id' | 'orgId'>) =>
      api.delete(`/api/v1/api-keys/${encodeURIComponent(id)}`, {
        query: { orgId: orgId ?? 'null' },
      }),
    onSuccess: (_done, { id, orgId }) => {
      const at = Date.now();
      client.setQueryData<InfiniteData<Page>>(
        [...root, principal, orgId, 'live'],
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
        queryKey: [...root, principal, orgId, 'revoked'],
        exact: true,
      });
      for (const part of ['detail', 'children', 'activity'])
        void client.invalidateQueries({ queryKey: [...root, principal, part] });
    },
  });
}

export function useCreateKey(principal: string) {
  const client = useQueryClient();
  const api = useToolApi();
  const root = useKeysRoot();
  const hosted = useToolScope() !== null;
  return useMutation({
    mutationFn: (body: z.input<typeof CreateApiKeySchema> & { orgId: string | null }) =>
      api.post('/api/v1/api-keys', CreatedApiKeySchema, body, {
        // The server mints the key in the request's mode, so send the one chosen in the dialog.
        // A Workbench token is Test and carries no mode header.
        ...(hosted ? {} : { headers: { [MODE_HEADER]: body.mode ?? 'live' } }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: [...root, principal] }),
  });
}

export type KeyStateName = 'revoked' | 'expired' | 'retired' | 'retiring' | 'active';

/** Revoked, expired, retired (its set time passed), retiring (set, still working) or active. */
export function keyState(key: ApiKey, now: number): KeyStateName {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && key.expiresAt <= now) return 'expired';
  if (typeof key.retireAt === 'number') return key.retireAt <= now ? 'retired' : 'retiring';
  return 'active';
}

export { SCOPE_LABEL };

const TerminalListSchema = pageOf(
  ScannerSchema.pick({ id: true, name: true, status: true }).extend({ kind: ScannerKindSchema }),
);

/** The org's terminals in service: the only devices a scan key can act as. */
export function useTerminals(orgId: string | null, enabled: boolean) {
  const api = useToolApi();
  const root = useKeysRoot();
  return useQuery({
    queryKey: [...root, 'terminals', orgId],
    enabled: enabled && orgId !== null,
    queryFn: async ({ signal }) => {
      const page = await api.get('/api/v1/scanners', TerminalListSchema, {
        query: { orgId: orgId ?? undefined, limit: 100 },
        signal,
      });
      return page.items.filter((s) => s.kind === 'terminal' && s.status !== 'revoked');
    },
  });
}
