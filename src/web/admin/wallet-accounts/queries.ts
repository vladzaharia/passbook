import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { WalletReissueResponseSchema } from '@/shared/contracts/wallet-provider-actions.ts';
import {
  PlatformWalletEnrolmentListSchema,
  type ResolveWalletMigration,
  type SaveWalletCredential,
  type WalletCredential,
  WalletCredentialCheckQueuedSchema,
  WalletCredentialCheckResultSchema,
  WalletCredentialListSchema,
  WalletCredentialSchema,
  type WalletEnrolment,
  WalletEnrolmentHoldResultSchema,
  WalletEnrolmentListSchema,
  WalletEnrolmentSchema,
  WalletMigrationQueuedSchema,
  WalletMigrationReportSchema,
  WalletMigrationResolvedSchema,
  type WalletProvider,
} from '@/shared/contracts/wallet-providers.ts';
import { PlatformWalletCredentialListSchema } from '@/shared/contracts/wallet-release.ts';
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
      api.get('/api/v1/platform/wallet-credentials', PlatformWalletCredentialListSchema, {
        signal,
      }),
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
    /** A card id is not a secret: it goes in a plain call and the answer is the credential. */
    setCard: (credential: WalletCredential, type: string, cardId: string) =>
      done(
        api.put(
          `/api/v1/platform/wallet-credentials/${credential.id}/cards`,
          WalletCredentialSchema,
          { type, cardId, expectedRevision: credential.revision },
        ),
      ),
    reissue: (orgId: string, provider: WalletProvider) =>
      api.post('/api/v1/wallet-providers/reissue', WalletReissueResponseSchema, {
        orgId,
        provider,
      }),
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

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export const isAbort = (cause: unknown) =>
  cause instanceof DOMException && cause.name === 'AbortError';

/**
 * Queues a check, then polls its result (about every 1.5 s, up to a minute). Leaving the page
 * aborts the poll; the caller sees an AbortError (`isAbort`).
 */
export function useCheckCredential() {
  const client = useQueryClient();
  const controller = useRef<AbortController>(new AbortController());
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    return () => c.abort();
  }, []);
  return async (target: CredentialTarget, credential: WalletCredential) => {
    const { signal } = controller.current;
    const base =
      target.kind === 'platform'
        ? `/api/v1/platform/wallet-credentials/${credential.id}`
        : `${orgBase(target.orgId)}/wallet-credentials/${credential.id}`;
    const queued = await api.post(`${base}/check`, WalletCredentialCheckQueuedSchema, undefined, {
      signal,
    });
    for (let i = 0; i < 40; i++) {
      await sleep(1500, signal);
      const result = await api.get(
        `${base}/checks/${queued.checkId}`,
        WalletCredentialCheckResultSchema,
        { signal },
      );
      if (result.status !== 'pending') {
        await client.invalidateQueries({ queryKey: KEY });
        return result;
      }
    }
    return { status: 'pending' as const, code: null, checkedAt: null, checkId: queued.checkId };
  };
}

const MIGRATE = '/api/v1/platform/wallet-credentials/migrate';

/** The pending and refused legacy accounts, one page after another. */
export function useMigrationReport() {
  return useInfiniteQuery(
    listQuery({
      queryKey: [...KEY, 'migration'],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get(MIGRATE, WalletMigrationReportSchema, { query: { after: pageParam }, signal }),
      getNextPageParam: (last: { next: string | null }) => last.next ?? undefined,
    }),
  );
}

export function useMigrationActions() {
  const client = useQueryClient();
  const done = async <T>(result: Promise<T>) => {
    const value = await result;
    await client.invalidateQueries({ queryKey: KEY });
    return value;
  };
  return {
    run: () => done(api.post(MIGRATE, WalletMigrationQueuedSchema)),
    resolve: (body: ResolveWalletMigration) =>
      done(api.post(`${MIGRATE}/resolve`, WalletMigrationResolvedSchema, body)),
  };
}
