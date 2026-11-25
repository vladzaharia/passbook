import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  AppleCallListSchema,
  IdentityCertificateListSchema,
  IdentityRunListSchema,
  IdentityRunSchema,
  type IdentityStatus,
  WalletIdentityListSchema,
} from '@/shared/contracts/identities.ts';
import { api, listQuery } from '@/web/lib/api.ts';

const KEY = ['identities'] as const;
const identityPath = (id: string) => `/api/v1/identities/${encodeURIComponent(id)}`;
const runPath = (id: string) => `/api/v1/identity-runs/${encodeURIComponent(id)}`;

export interface WalletIdentityFilter {
  kind?: 'platform' | 'managed' | 'own';
  status?: IdentityStatus;
  orgId?: string;
}

/** The Apple table: server-side filters, 50 at a time. */
export function useWalletIdentityPages(filter: WalletIdentityFilter) {
  return useInfiniteQuery(
    listQuery({
      queryKey: [...KEY, 'wallet', filter],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get('/api/v1/wallet-identities', WalletIdentityListSchema, {
          query: { ...filter, cursor: pageParam, limit: 50 },
          signal,
        }),
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
  );
}

export function useIdentityRuns(query: { orgId?: string; targetId?: string }, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'runs', query],
    enabled,
    queryFn: ({ signal }) =>
      api.get('/api/v1/identity-runs', IdentityRunListSchema, {
        query: { ...query, limit: 20 },
        signal,
      }),
    // A run in flight moves on its own.
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => ['queued', 'running', 'waiting'].includes(r.state))
        ? 5000
        : false,
  });
}

export function useIdentityCertificates(identityId: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'certificates', identityId],
    enabled,
    queryFn: ({ signal }) =>
      api.get(`${identityPath(identityId)}/certificates`, IdentityCertificateListSchema, {
        signal,
      }),
  });
}

export function useAppleCalls() {
  return useQuery({
    queryKey: [...KEY, 'apple-calls'],
    // An unreachable provisioner stays down for seconds; show Retry instead of spinning.
    retry: false,
    queryFn: ({ signal }) =>
      api.get('/api/v1/platform/apple-calls', AppleCallListSchema, { signal }),
  });
}

/** Starts the managed identity. A retry of the same request reuses its Idempotency-Key. */
export function useStartManagedIdentity(orgId: string) {
  const client = useQueryClient();
  const key = useRef<{ handle: string; key: string }>(undefined);
  return useMutation({
    mutationFn: (handle: string | undefined) => {
      const h = handle ?? '';
      if (key.current?.handle !== h) key.current = { handle: h, key: crypto.randomUUID() };
      return api.post(
        `/api/v1/orgs/${encodeURIComponent(orgId)}/identities/apple`,
        IdentityRunSchema,
        handle ? { handle } : {},
        { headers: { 'idempotency-key': key.current.key } },
      );
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: KEY }),
        // The Brand page reads the run from its own view.
        client.invalidateQueries({ queryKey: ['orgs', 'pass-setup', orgId] }),
      ]),
  });
}

export function useRenewIdentity(identityId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`${identityPath(identityId)}/renew`, IdentityRunSchema, {}),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRunAction(runId: string, action: 'retry' | 'cancel') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`${runPath(runId)}/${action}`, IdentityRunSchema, {}),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRevokeCertificate(identityId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { certificateId: string; confirm: string }) =>
      api.post(`${identityPath(identityId)}/revoke-certificate`, IdentityRunSchema, {
        ...body,
        reason: 'compromised',
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}
