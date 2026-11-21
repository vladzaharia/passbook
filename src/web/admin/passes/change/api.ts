import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BroadcastListSchema, BroadcastSchema } from '@/shared/contracts/broadcasts.ts';
import {
  BroadcastUndoResultSchema,
  ChangeRunPreviewSchema,
} from '@/shared/contracts/broadcasts-change.ts';
import { api } from '../../../lib/api.ts';
import { broadcastKeys, broadcastQuery } from '../../messages/api.ts';

const path = (id: string) => `/api/v1/broadcasts/${encodeURIComponent(id)}`;

export interface ChangeBody {
  orgId: string;
  target: Record<string, unknown>;
  patch: Record<string, unknown>;
  notify: boolean;
  message?: string | undefined;
}

/** The server's dry run: counts, who is told, and sample diffs. Counts come from the 200 newest. */
export function useChangePreview(body: ChangeBody | undefined) {
  return useQuery({
    queryKey: ['admin', 'broadcasts', 'change-preview', body],
    queryFn: ({ signal }) =>
      api.post('/api/v1/broadcasts/preview', ChangeRunPreviewSchema, body, { signal }),
    enabled: Boolean(body),
    staleTime: 15_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

export function useChangeActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: broadcastKeys.all });
  return {
    /** One key per intent: a double click or a retry makes one run. */
    create: useMutation({
      mutationFn: ({
        body,
        key,
        at,
      }: {
        body: ChangeBody & { expectCount: number };
        key: string;
        at?: number | undefined;
      }) => {
        const { expectCount, ...rest } = body;
        return api.post(
          '/api/v1/broadcasts',
          BroadcastSchema,
          {
            ...rest,
            kind: 'change',
            send: at === undefined ? 'now' : 'schedule',
            ...(at === undefined ? {} : { at }),
            target: { ...rest.target, expectCount },
          },
          { headers: { 'idempotency-key': key } },
        );
      },
      onSuccess: refresh,
    }),
    stop: useMutation({
      mutationFn: (id: string) => api.post(`${path(id)}/stop`, BroadcastSchema),
      onSuccess: refresh,
    }),
    undo: useMutation({
      mutationFn: (id: string) => api.post(`${path(id)}/undo`, BroadcastUndoResultSchema),
      onSuccess: refresh,
    }),
    resume: useMutation({
      mutationFn: ({ id, expectCount }: { id: string; expectCount: number }) =>
        api.post(`${path(id)}/retry`, BroadcastSchema, undefined, {
          query: { expectCount },
        }),
      onSuccess: refresh,
    }),
  };
}

export { broadcastQuery };

/** The undo run of a change (a silent child), if it was undone; polls while it works. */
export function useUndoRun(parentId: string, orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...broadcastKeys.detail(parentId), 'undo-run'],
    queryFn: async ({ signal }) => {
      const page = await api.get('/api/v1/broadcasts', BroadcastListSchema, {
        query: { orgId, kind: 'change', limit: 50 },
        signal,
      });
      return page.items.find((b) => b.parentId === parentId) ?? null;
    },
    enabled,
    refetchInterval: (query) => (query.state.data?.state === 'sending' ? 2000 : false),
  });
}
