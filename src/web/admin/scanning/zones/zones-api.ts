import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  type CreateScanZoneSchema,
  type ScanZone,
  ScanZoneListSchema,
  ScanZoneSchema,
  type UpdateScanZoneSchema,
} from '@/shared/contracts/scan-access.ts';
import { api } from '@/web/lib/api.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';

export const zoneKeys = {
  all: ['admin', 'scanning', 'zones'] as const,
  list: (orgId: string | undefined, archived: boolean) =>
    ['admin', 'scanning', 'zones', 'list', orgId ?? null, archived] as const,
};

const PAGES = 10;

/** Every zone of the org (zones are org data, shared by Live and Test), active or archived. */
export function useZones(orgId: string | undefined, archived = false, enabled = true) {
  const scope = useOrgScope();
  const allowed = Boolean(
    enabled &&
      !scope.isLoading &&
      !scope.isError &&
      orgId &&
      orgId === scope.orgId &&
      scope.membership?.capabilities.includes('scanning:read'),
  );
  return useQuery({
    queryKey: [...zoneKeys.list(allowed ? orgId : undefined, archived), allowed],
    enabled: allowed,
    queryFn: async ({ signal }): Promise<ScanZone[]> => {
      if (!orgId) throw new Error('Choose an authorized organization.');
      const items: ScanZone[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < PAGES; page++) {
        const next = await api.get('/api/v1/scan-zones', ScanZoneListSchema, {
          query: { orgId, archived: archived ? 'true' : 'false', cursor, limit: 200 },
          signal,
        });
        items.push(...next.items);
        if (!next.nextCursor) break;
        cursor = next.nextCursor;
      }
      return items;
    },
  });
}

/** An older server has no zones route: the tab and pickers step aside. */
export const zonesUnavailable = (error: unknown): boolean =>
  isApiError(error) && (error.status === 404 || error.status === 405);

function useRefreshZones() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: zoneKeys.all }),
      client.invalidateQueries({ queryKey: ['admin', 'scanning', 'sessions'] }),
    ]);
}
export function useCreateZone() {
  const refresh = useRefreshZones();
  return useMutation({
    mutationFn: (body: z.input<typeof CreateScanZoneSchema>) =>
      api.post('/api/v1/scan-zones', ScanZoneSchema, body),
    onSuccess: refresh,
  });
}
export function useUpdateZone(id: string) {
  const refresh = useRefreshZones();
  return useMutation({
    mutationFn: (body: z.input<typeof UpdateScanZoneSchema>) =>
      api.patch(`/api/v1/scan-zones/${encodeURIComponent(id)}`, ScanZoneSchema, body),
    onSuccess: refresh,
  });
}
export function useArchiveZone() {
  const refresh = useRefreshZones();
  return useMutation({
    mutationFn: ({ id, archive }: { id: string; archive: boolean }) =>
      api.post(
        `/api/v1/scan-zones/${encodeURIComponent(id)}/${archive ? 'archive' : 'restore'}`,
        ScanZoneSchema,
      ),
    onSuccess: refresh,
  });
}
