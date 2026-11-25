import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { BrandKitSchema } from '@/shared/contracts/brand.ts';
import {
  type PassSetupPatch,
  PassSetupResultSchema,
  PassSetupSchema,
  type StageBrandAssetSchema,
  StagedBrandAssetSchema,
} from '@/shared/contracts/pass-setup.ts';
import {
  GoogleIssuerRunSchema,
  GoogleManagedStatusSchema,
  GoogleSharedIssuerInfoSchema,
  GoogleSharedIssuerSchema,
} from '@/shared/contracts/wallet-providers.ts';
import { api } from '@/web/lib/api.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { useMode } from '@/web/lib/mode.ts';
import { orgKeys } from '../orgs/queries.ts';

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;

export const passSetupKey = (orgId: string, mode: string) =>
  ['orgs', 'pass-setup', orgId, mode] as const;

/** GET /orgs/{orgId}/pass-setup: the view in the caller's mode. */
export const getPassSetup = (orgId: string, signal?: AbortSignal) =>
  api.get(`${base(orgId)}/pass-setup`, PassSetupSchema, signal ? { signal } : {});

/** PATCH /orgs/{orgId}/pass-setup, with `?dryRun=true` for the review. */
export const patchPassSetup = (orgId: string, body: PassSetupPatch, dryRun: boolean) =>
  api.patch(`${base(orgId)}/pass-setup`, PassSetupResultSchema, body, {
    query: dryRun ? { dryRun: 'true' } : {},
  });

/** POST /orgs/{orgId}/brand-assets: stages a PNG; the save that names its sha commits it. */
export const stageBrandAsset = (orgId: string, body: z.input<typeof StageBrandAssetSchema>) =>
  api.post(`${base(orgId)}/brand-assets`, StagedBrandAssetSchema, body);

export function usePassSetup(orgId: string, enabled = true) {
  const mode = useMode();
  return useQuery({
    enabled,
    queryKey: passSetupKey(orgId, mode),
    queryFn: ({ signal }) => getPassSetup(orgId, signal),
  });
}

/** Saves; the page, the sidebar count and the old org reads all reload. */
export function useSavePassSetup(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PassSetupPatch) => patchPassSetup(orgId, body, false),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['orgs', 'pass-setup', orgId] }),
        client.invalidateQueries({ queryKey: orgKeys.all }),
        client.invalidateQueries({ queryKey: ['settings'] }),
        client.invalidateQueries({ queryKey: ['channels'] }),
        // The designer's paper preview reads the org's footer from the brand kit.
        client.invalidateQueries({ queryKey: ['admin', 'brand', orgId] }),
      ]);
    },
  });
}

/** 409 PASS_SETUP_CHANGED: someone saved first. */
export const isSetupChanged = (cause: unknown): boolean =>
  isApiError(cause) && cause.status === 409 && cause.code === 'PASS_SETUP_CHANGED';

/** The saved web logo's URL; the pass-setup view carries its sha, not where it is served. */
export function useWebLogoUrl(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'brand', orgId],
    queryFn: ({ signal }) => api.get('/api/v1/brand', BrandKitSchema, { query: { orgId }, signal }),
    enabled,
    select: (kit) => kit.webLogo?.url,
  });
}

/** The mark holders see for the org (its choice, fitted to its plan); full until it loads. */
export function useBrandMark(orgId: string | undefined) {
  return (
    useQuery({
      queryKey: ['admin', 'brand', orgId],
      queryFn: ({ signal }) =>
        api.get('/api/v1/brand', BrandKitSchema, { query: { orgId }, signal }),
      enabled: Boolean(orgId),
      // A 403 (no org access) draws the full footer rather than retrying.
      retry: false,
      select: (kit) => kit.mark,
    }).data ?? 'full'
  );
}

const googleBase = (orgId: string) => `${base(orgId)}/wallet-accounts/google`;
const GOOGLE_KEY = (orgId: string) => ['orgs', 'google-managed', orgId] as const;

/** POST /orgs/{orgId}/wallet-accounts/google/managed: PassBook makes the issuer (Live only). */
export const requestManagedGoogle = (orgId: string) =>
  api.post(`${googleBase(orgId)}/managed`, GoogleIssuerRunSchema, { mode: 'live' });

/** GET /orgs/{orgId}/wallet-accounts/google/shared: the address the org adds to its own issuer. */
export const getGoogleSharedInfo = (orgId: string, signal?: AbortSignal) =>
  api.get(`${googleBase(orgId)}/shared`, GoogleSharedIssuerInfoSchema, signal ? { signal } : {});

/** POST /orgs/{orgId}/wallet-accounts/google/shared: connect the org's own issuer. */
export const shareGoogleIssuer = (orgId: string, issuerId: string) =>
  api.post(`${googleBase(orgId)}/shared`, GoogleSharedIssuerSchema, { issuerId });

const ACTIVE = new Set(['queued', 'running', 'waiting']);

/** The latest managed-issuer run; polls while it works. */
export function useManagedGoogle(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: GOOGLE_KEY(orgId),
    enabled,
    queryFn: ({ signal }) =>
      api.get(`${googleBase(orgId)}/managed`, GoogleManagedStatusSchema, { signal }),
    refetchInterval: (q) =>
      q.state.data?.run && ACTIVE.has(q.state.data.run.state) ? 4000 : false,
  });
}

export function useGoogleSharedInfo(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...GOOGLE_KEY(orgId), 'shared'],
    enabled,
    queryFn: ({ signal }) => getGoogleSharedInfo(orgId, signal),
  });
}

/** Starts the managed issuer or connects an own one; the account card and the checks reload. */
export function useGoogleAccountActions(orgId: string) {
  const client = useQueryClient();
  const done = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: GOOGLE_KEY(orgId) }),
      client.invalidateQueries({ queryKey: ['orgs', 'pass-setup', orgId] }),
      client.invalidateQueries({ queryKey: ['wallet-accounts'] }),
    ]);
  return {
    managed: useMutation({ mutationFn: () => requestManagedGoogle(orgId), onSuccess: done }),
    share: useMutation({
      mutationFn: (issuerId: string) => shareGoogleIssuer(orgId, issuerId),
      onSuccess: done,
    }),
  };
}
