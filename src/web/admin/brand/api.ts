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

export function usePassSetup(orgId: string) {
  const mode = useMode();
  return useQuery({
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
