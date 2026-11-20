import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type OrgEntitlementsDto,
  OrgEntitlementsSchema,
} from '@/shared/contracts/entitlement-admin.ts';
import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import { api } from '@/web/lib/api.ts';
import { isApiError } from '@/web/lib/errors.ts';
import type { OverrideMap } from './values.ts';

export const featureKeys = {
  org: (orgId: string) => ['orgs', 'features', orgId] as const,
};

const path = (orgId: string) => `/api/v1/platform/orgs/${encodeURIComponent(orgId)}/entitlements`;

export function useOrgFeatures(orgId: string) {
  return useQuery({
    queryKey: featureKeys.org(orgId),
    queryFn: ({ signal }) => api.get(path(orgId), OrgEntitlementsSchema, { signal }),
  });
}

export interface FeaturesChange {
  preset: string;
  overrides: OverrideMap;
}

/**
 * Saves the whole state against the revision that was read. A refused save (409) reloads the tab,
 * so the next try starts from what is stored.
 */
export function useSetFeatures(orgId: string, revision: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: FeaturesChange) =>
      api.put(path(orgId), OrgEntitlementsSchema, {
        expectedRevision: revision,
        preset: change.preset,
        overrides: Object.fromEntries(
          Object.entries(change.overrides).map(([key, o]) => [key as EntitlementKey, o]),
        ),
      }),
    onSuccess: (next: OrgEntitlementsDto) => {
      client.setQueryData(featureKeys.org(orgId), next);
      // The audit log and the directory read the same org.
      void client.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (cause) => {
      if (isApiError(cause) && cause.isConflict)
        void client.invalidateQueries({ queryKey: featureKeys.org(orgId) });
    },
  });
}
