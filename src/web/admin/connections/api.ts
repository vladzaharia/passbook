import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';
import { OkSchema } from '@/shared/contracts/common.ts';
import {
  ConnectionDetailSchema,
  ConnectionListSchema,
  ConnectionSchema,
  ConnectorInfoSchema,
  ConnectorListSchema,
  ResolveWebhookFailureResponseSchema,
  SyncNowResponseSchema,
  TestConnectionResponseSchema,
  type UpdateConnectionSchema,
} from '@/shared/contracts/connections.ts';
import { api } from '../../lib/api.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';

export interface ConnectionFilters {
  orgId?: string | undefined;
  health?: string | undefined;
  q?: string | undefined;
}

export const connectionKeys = {
  all: ['admin', 'connections'] as const,
  list: (f: ConnectionFilters, userId?: string) =>
    ['admin', 'connections', 'list', f, userId ?? null] as const,
  detail: (id: string) => ['admin', 'connections', 'detail', id] as const,
  connectors: ['admin', 'connectors'] as const,
};

/** Pickers and name lookups: the first 200 in one request. The list page pages instead. */
export function useConnections(filters: ConnectionFilters, enabled = true) {
  const scope = useOrgScope();
  const allowed = Boolean(
    filters.orgId &&
      filters.orgId === scope.orgId &&
      scope.membership?.capabilities.includes('integrations:read'),
  );
  return useQuery({
    queryKey: connectionKeys.list(
      { ...filters, orgId: allowed ? scope.orgId : undefined },
      allowed ? scope.membership?.userId : undefined,
    ),
    queryFn: ({ signal }) => {
      if (!allowed || !scope.orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/connections', ConnectionListSchema, {
        query: { ...filters, orgId: scope.orgId, limit: 200 },
        signal,
      });
    },
    enabled: enabled && allowed,
    placeholderData: (previous, query) =>
      allowed &&
      scope.orgId &&
      query?.queryKey[3].orgId === scope.orgId &&
      query?.queryKey[4] === scope.membership?.userId
        ? previous
        : undefined,
  });
}

/** The Connections list: 50 at a time; Load more fetches the next page. */
export function useConnectionPages(filters: ConnectionFilters) {
  const scope = useOrgScope();
  const allowed = Boolean(
    filters.orgId &&
      filters.orgId === scope.orgId &&
      scope.membership?.capabilities.includes('integrations:read'),
  );
  return useInfiniteQuery({
    queryKey: [
      ...connectionKeys.all,
      'pages',
      { ...filters, orgId: allowed ? scope.orgId : undefined },
      allowed ? (scope.membership?.userId ?? null) : null,
    ] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!allowed || !scope.orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/connections', ConnectionListSchema, {
        query: { ...filters, orgId: scope.orgId, cursor: pageParam, limit: 50 },
        signal,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
    placeholderData: (previous, query) =>
      allowed &&
      scope.orgId &&
      query?.queryKey[3].orgId === scope.orgId &&
      query?.queryKey[4] === scope.membership?.userId
        ? previous
        : undefined,
  });
}

export const connectionDetailQuery = (id: string) =>
  queryOptions({
    queryKey: connectionKeys.detail(id),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/connections/${id}`, ConnectionDetailSchema, { signal }),
  });

export function useConnection(id: string | undefined) {
  return useQuery({ ...connectionDetailQuery(id ?? ''), enabled: Boolean(id) });
}

function useConnectorScope(orgId: string | undefined) {
  const scope = useOrgScope();
  return !scope.isLoading &&
    !scope.isError &&
    orgId &&
    orgId === scope.orgId &&
    scope.membership?.capabilities.includes('integrations:read')
    ? { orgId, userId: scope.membership.userId }
    : undefined;
}

export function useConnectors(orgId: string | undefined) {
  const selected = useConnectorScope(orgId);
  return useQuery({
    queryKey: [
      ...connectionKeys.connectors,
      'list',
      selected?.orgId ?? null,
      selected?.userId ?? null,
    ],
    queryFn: ({ signal }) => {
      if (!selected) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/connectors', ConnectorListSchema, {
        query: { orgId: selected.orgId },
        signal,
      });
    },
    enabled: Boolean(selected),
    staleTime: 5 * 60_000,
  });
}

export function useConnector(type: string | undefined, orgId: string | undefined) {
  const selected = useConnectorScope(orgId);
  return useQuery({
    queryKey: [
      ...connectionKeys.connectors,
      'detail',
      selected?.orgId ?? null,
      selected?.userId ?? null,
      type,
    ],
    queryFn: ({ signal }) => {
      if (!selected || !type) throw new Error('Choose an authorized organization.');
      return api.get(`/api/v1/connectors/${type}`, ConnectorInfoSchema, {
        query: { orgId: selected.orgId },
        signal,
      });
    },
    enabled: Boolean(type && selected),
    staleTime: 5 * 60_000,
  });
}

export type ConnectionPatch = z.input<typeof UpdateConnectionSchema>;

export function useConnectionActions(id: string) {
  const qc = useQueryClient();
  const done = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: connectionKeys.all }),
      qc.invalidateQueries({ queryKey: ['palette'] }),
    ]);
  return {
    update: useMutation({
      mutationFn: (patch: ConnectionPatch) =>
        api.patch(`/api/v1/connections/${id}`, ConnectionSchema, patch),
      onSuccess: done,
    }),
    test: useMutation({
      mutationFn: () => api.post(`/api/v1/connections/${id}/test`, TestConnectionResponseSchema),
      onSuccess: done,
    }),
    sync: useMutation({
      mutationFn: () => api.post(`/api/v1/connections/${id}/sync`, SyncNowResponseSchema),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: () => api.delete(`/api/v1/connections/${id}`),
      onSuccess: done,
    }),
  };
}

/** type -> display name; falls back to the type until the list loads. */
export function useConnectorNames(orgId: string | undefined): (type: string) => string {
  const list = useConnectors(orgId);
  const items = list.data?.items;
  return useMemo(() => {
    const names = new Map((items ?? []).map((c) => [c.type, c.displayName]));
    return (type: string) => names.get(type) ?? type;
  }, [items]);
}

const RetainedWebhooksSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      eventRef: z.string(),
      generation: z.number(),
      connectionMode: z.enum(['webhook', 'hybrid', 'unknown']),
      state: z.enum(['pending', 'failed', 'blocked', 'resolved', 'ignored']),
      errorCode: z.string().nullable(),
      uncertainItems: z.number().int().nonnegative(),
      receivedAt: z.number(),
      updatedAt: z.number(),
    }),
  ),
});
export type RetainedWebhook = z.infer<typeof RetainedWebhooksSchema>['items'][number];

/** Retained webhook work for a connection; Live only, so Test mode skips the request. */
export function useWebhookFailures(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...connectionKeys.detail(id), 'webhook-failures'],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/connections/${id}/webhook-failures`, RetainedWebhooksSchema, { signal }),
    enabled,
  });
}

export function useReplayWebhook(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (retentionId: string) =>
      api.post(`/api/v1/connections/${id}/webhook-failures/${retentionId}/replay`, OkSchema),
    onSettled: () => qc.invalidateQueries({ queryKey: connectionKeys.detail(id) }),
  });
}

export function useResolveWebhook(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (retentionId: string) =>
      api.post(
        `/api/v1/connections/${id}/webhook-failures/${retentionId}/resolve`,
        ResolveWebhookFailureResponseSchema,
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: connectionKeys.detail(id) }),
  });
}
