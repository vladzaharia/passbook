import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Mode } from '@/shared/contracts/common.ts';
import {
  PlatformWalletEnrolmentListSchema,
  type SaveWalletCredential,
  type WalletCredential,
  WalletCredentialListSchema,
  WalletCredentialSchema,
  type WalletEnrolment,
  WalletEnrolmentHoldResultSchema,
  WalletEnrolmentListSchema,
  WalletEnrolmentSchema,
  type WalletProvider,
} from '@/shared/contracts/wallet-providers.ts';
import { api, listQuery } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';

const KEY = ['wallet-accounts'] as const;
const orgBase = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;

/** Org reads follow the session mode, so the mode is part of the key. */
export function useOrgCredentials(orgId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: [...KEY, 'org-credentials', orgId, mode],
    queryFn: ({ signal }) =>
      api.get(`${orgBase(orgId)}/wallet-credentials`, WalletCredentialListSchema, { signal }),
  });
}

export function useOrgEnrolments(orgId: string, enabled = true) {
  const mode = useMode();
  return useQuery({
    queryKey: [...KEY, 'org-enrolments', orgId, mode],
    enabled,
    queryFn: ({ signal }) =>
      api.get(`${orgBase(orgId)}/wallet-enrolments`, WalletEnrolmentListSchema, { signal }),
  });
}

export function usePlatformCredentials() {
  return useQuery({
    queryKey: [...KEY, 'platform-credentials'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/platform/wallet-credentials', WalletCredentialListSchema, { signal }),
  });
}

export function usePlatformEnrolments(provider: WalletProvider) {
  return useInfiniteQuery(
    listQuery({
      queryKey: [...KEY, 'platform-enrolments', provider],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get('/api/v1/platform/wallet-enrolments', PlatformWalletEnrolmentListSchema, {
          query: { provider, cursor: pageParam, limit: 50 },
          signal,
        }),
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
  );
}

export type CredentialTarget = { kind: 'platform'; mode: Mode } | { kind: 'org'; orgId: string };

/**
 * Plain calls, not mutations: a mutation keeps its variables in the cache, and these carry
 * private keys. The caller shows `safeError` text and never the server's.
 */
export function useWalletActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: KEY });
  const done = async <T>(result: Promise<T>): Promise<T> => {
    const value = await result;
    await refresh();
    return value;
  };
  return {
    saveCredential: (target: CredentialTarget, body: SaveWalletCredential) =>
      done(
        target.kind === 'platform'
          ? api.put('/api/v1/platform/wallet-credentials', WalletCredentialSchema, {
              ...body,
              mode: target.mode,
            })
          : api.put(`${orgBase(target.orgId)}/wallet-credentials`, WalletCredentialSchema, body),
      ),
    revokeCredential: (target: CredentialTarget, credential: WalletCredential) =>
      done(
        api.post(
          target.kind === 'platform'
            ? `/api/v1/platform/wallet-credentials/${credential.id}/revoke`
            : `${orgBase(target.orgId)}/wallet-credentials/${credential.id}/revoke`,
          WalletCredentialSchema,
          { expectedRevision: credential.revision },
        ),
      ),
    setSource: (
      orgId: string,
      e: WalletEnrolment,
      source: NonNullable<WalletEnrolment['source']>,
    ) =>
      done(
        api.put(`${orgBase(orgId)}/wallet-enrolments/${e.provider}`, WalletEnrolmentSchema, {
          source,
          expectedRevision: e.enrolmentRevision,
        }),
      ),
    act: (orgId: string, e: WalletEnrolment, action: 'enable' | 'disable' | 'revoke') =>
      done(
        api.post(
          `${orgBase(orgId)}/wallet-enrolments/${e.provider}/${action}`,
          WalletEnrolmentSchema,
          { expectedRevision: e.enrolmentRevision },
        ),
      ),
    hold: (orgId: string, mode: Mode, provider: WalletProvider, reason: string) =>
      done(
        api.post(
          `/api/v1/platform/orgs/${encodeURIComponent(orgId)}/wallet-enrolments/${mode}/${provider}/hold`,
          WalletEnrolmentHoldResultSchema,
          { reason },
        ),
      ),
    release: (orgId: string, mode: Mode, provider: WalletProvider) =>
      done(
        api.post(
          `/api/v1/platform/orgs/${encodeURIComponent(orgId)}/wallet-enrolments/${mode}/${provider}/release`,
          WalletEnrolmentHoldResultSchema,
          {},
        ),
      ),
  };
}
