import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { BulkRunSchema } from '@/shared/contracts/pass-bulk-runs.ts';
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

const runKey = (id: string) => ['admin', 'passes', 'bulk-run', id] as const;

/** A bulk run's progress; polls while it is going. */
export function useBulkRun(id: string | undefined, orgId: string | undefined) {
  return useQuery({
    queryKey: runKey(id ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/bulk-runs/${id}`, BulkRunSchema, { query: { orgId }, signal }),
    enabled: Boolean(id && orgId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'queued' || state === 'running' ? 2000 : false;
    },
  });
}

/** Starts a bulk run over every pass a filter matches. */
export function useStartBulkRun() {
  return useMutation({
    mutationFn: (body: {
      action: 'void' | 'send_email' | 'remove';
      message?: string;
      orgId: string;
      selection: { filter: PassFilter; expectCount: number };
    }) => api.post('/api/v1/passes/bulk-runs', BulkRunSchema, body),
  });
}

export function useStopBulkRun(orgId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/passes/bulk-runs/${id}/stop`, BulkRunSchema, {}, { query: { orgId } }),
    onSuccess: (run) => qc.setQueryData(runKey(run.id), run),
  });
}
