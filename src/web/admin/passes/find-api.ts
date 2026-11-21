import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PassFilter } from '@/shared/contracts/pass-selection.ts';
import { type PassView, PassViewListSchema } from '@/shared/contracts/pass-views.ts';
import { PassListSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { useMode } from '../../lib/mode.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { FIND_VIEW_CHIPS } from './find-query.ts';

const viewsKey = (orgId: string | undefined) => ['admin', 'passes', 'views', orgId] as const;

/** The org's saved views of the passes list. */
export function useSavedViews(orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: viewsKey(orgId),
    queryFn: ({ signal }) =>
      api.get('/api/v1/passes/views', PassViewListSchema, { query: { orgId }, signal }),
    enabled: enabled && Boolean(orgId),
    select: (r) => r.items,
  });
}

export function useSaveViews(orgId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: PassView[]) =>
      api.put('/api/v1/passes/views', PassViewListSchema, { orgId, items }),
    onSuccess: (saved) => qc.setQueryData(viewsKey(orgId), saved),
  });
}

/** How many passes each view (and "All") matches, one cheap request each. */
export function useViewCounts(
  orgId: string | undefined,
  views: readonly PassView[],
  enabled: boolean,
) {
  const mode = useMode();
  const scope = useOrgScope();
  const shown = views.slice(0, FIND_VIEW_CHIPS);
  const results = useQueries({
    queries: [{ id: 'all', filter: {} as PassFilter }, ...shown].map((v) => ({
      queryKey: ['admin', 'passes', 'view-count', orgId, mode, JSON.stringify(v.filter)],
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        const { match, scan, onDevice, ...rest } = v.filter;
        return api.get('/api/v1/passes', PassListSchema, {
          query: {
            ...rest,
            ...(match ? { match: JSON.stringify(match) } : {}),
            ...(scan ? { scan: JSON.stringify(scan) } : {}),
            ...(onDevice === undefined ? {} : { onDevice }),
            orgId: scope.orgId,
            count: true,
            limit: 1,
          },
          signal,
        });
      },
      enabled: enabled && views.length > 0 && Boolean(orgId),
      staleTime: 30_000,
    })),
  });
  return new Map(
    results.map((r, i) => [i === 0 ? 'all' : (shown[i - 1]?.id ?? ''), r.data?.count]),
  );
}
