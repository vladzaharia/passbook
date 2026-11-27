import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type SimulatePassInput, SimulatePassResponseSchema } from '@/shared/contracts/events.ts';
import {
  PassActionResponseSchema,
  PassDetailSchema,
  PassListSchema,
} from '@/shared/contracts/passes.ts';
import { syncKeys } from '../../admin/passes/detail/sync-api.ts';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import { useToolHost } from '../host/tool-host.tsx';

const LIST_POLL_MS = 8000;
const PAGE = 50;

/** One key family for the tool: a void or a simulated event refreshes all of it. */
const ALL = ['workbench', 'passes'] as const;

/** The context's Test passes, newest first; reread while the tab is visible so a simulated install shows. */
export function usePassList() {
  const api = useToolApi();
  const key = useToolKey();
  const { orgId } = useToolHost().context;
  return useInfiniteQuery({
    queryKey: [...ALL, 'list', orgId, ...key],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/passes', PassListSchema, {
        query: { orgId, limit: PAGE, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: LIST_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** One pass in full: its preview, versions and links. Absent while nothing is selected. */
export function usePassDetail(id: string | undefined) {
  const api = useToolApi();
  const key = useToolKey();
  return useQuery({
    queryKey: [...ALL, 'detail', id, ...key],
    queryFn: ({ signal }) => api.get(`/api/v1/passes/${id}`, PassDetailSchema, { signal }),
    enabled: id !== undefined,
    refetchInterval: LIST_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Everything one pass shows: its detail, the list and the shared trail and devices. */
function useRefresh(id: string) {
  const qc = useQueryClient();
  return useMemo(
    () => async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ALL }),
        qc.invalidateQueries({ queryKey: syncKeys.pass(id) }),
      ]);
    },
    [qc, id],
  );
}

/** Sends one real Test event for the pass (`POST /passes/{id}/simulate`). */
export function useSimulate(id: string) {
  const api = useToolApi();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (input: SimulatePassInput) =>
      api.post(`/api/v1/passes/${id}/simulate`, SimulatePassResponseSchema, input),
    onSuccess: refresh,
  });
}

/** Voids the pass; there is no unvoid on the token, so it stays voided. */
export function useVoidPass(id: string) {
  const api = useToolApi();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: () => api.post(`/api/v1/passes/${id}/void`, PassActionResponseSchema),
    onSuccess: refresh,
  });
}
