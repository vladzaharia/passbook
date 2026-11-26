import { useQuery } from '@tanstack/react-query';
import { ScanZoneListSchema } from '@/shared/contracts/scan-access.ts';
import { api } from '@/web/lib/api.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import type { ToolScope } from '@/web/lib/tool-api.tsx';

export const zoneKeys = {
  /** Every zone query; the console's full lists (zones/zones-api.ts) sit under it. */
  all: ['admin', 'scanning', 'zones'] as const,
  list: (orgId: string | undefined) => ['admin', 'scanning', 'zones', orgId ?? null] as const,
};

/**
 * The organization's active zones, in tree order, in one request. Pickers read it; a person
 * without scanning access gets an error state and falls back to typed keys.
 */
export function useZones(enabled = true) {
  const scope = useOrgScope();
  const orgId =
    enabled &&
    !scope.isLoading &&
    !scope.isError &&
    scope.membership?.capabilities.includes('scanning:read')
      ? scope.orgId
      : undefined;
  return useQuery({
    queryKey: zoneKeys.list(orgId),
    enabled: orgId !== undefined,
    staleTime: 30_000,
    queryFn: ({ signal }) => {
      if (!orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/scan-zones', ScanZoneListSchema, {
        query: { orgId, limit: 200 },
        signal,
      });
    },
  });
}

/**
 * The same list for a host that pins its organization and client (the Workbench): no URL scope
 * or session read, and the host's client answers for its own access.
 */
export function usePinnedZones(scope: ToolScope, enabled = true) {
  const orgId = enabled ? scope.orgId : undefined;
  return useQuery({
    queryKey: [...zoneKeys.list(orgId), scope.client, scope.mode],
    enabled: orgId !== undefined,
    staleTime: 30_000,
    queryFn: ({ signal }) => {
      if (!orgId) throw new Error('Choose an authorized organization.');
      return scope.api.get('/api/v1/scan-zones', ScanZoneListSchema, {
        query: { orgId, limit: 200 },
        signal,
      });
    },
  });
}
