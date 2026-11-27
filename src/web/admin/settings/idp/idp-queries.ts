import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DriftListSchema, FrozenSchema, IdpCallListSchema } from '@/shared/contracts/idp-access.ts';
import { StartedOperationSchema } from '@/shared/contracts/operations.ts';
import { api } from '@/web/lib/api.ts';
import { trackOperation } from '@/web/ui/operation/index.ts';
import { IDP_KEY } from '../../idp/status-queries.ts';

const BASE = '/api/v1/platform/idp';

export function useDrift(enabled = true) {
  return useQuery({
    queryKey: [...IDP_KEY, 'drift'],
    queryFn: ({ signal }) => api.get(`${BASE}/drift`, DriftListSchema, { signal }),
    enabled,
    staleTime: 15_000,
  });
}

/** The binding's ledger from `since` (ms), a page at a time. Only fetched while the card is open. */
export function useCalls(since: number, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...IDP_KEY, 'calls', since],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      api.get(`${BASE}/calls`, IdpCallListSchema, {
        query: { since, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Check now, the dry run and the breaker clear answer 202 with an operation the page follows. */
export function useIdpActions() {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: IDP_KEY });
  return {
    refresh,
    check: useMutation({
      mutationFn: async (dryRun: boolean) => {
        const { operation } = await api.post(`${BASE}/reconcile`, StartedOperationSchema, {
          dryRun,
        });
        trackOperation(operation);
        return operation;
      },
    }),
    clearBreaker: useMutation({
      mutationFn: async () => {
        const { operation } = await api.post(`${BASE}/scim-breaker/clear`, StartedOperationSchema);
        trackOperation(operation);
        return operation;
      },
    }),
    freeze: useMutation({
      mutationFn: (reason: string) => api.post(`${BASE}/freeze`, FrozenSchema, { reason }),
      onSuccess: refresh,
    }),
  };
}
