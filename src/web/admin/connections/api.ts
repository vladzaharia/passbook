import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { z } from 'zod';
import {
  ConnectionDetailSchema,
  ConnectionListSchema,
  ConnectionSchema,
  ConnectorInfoSchema,
  ConnectorListSchema,
  SyncNowResponseSchema,
  TestConnectionResponseSchema,
  type UpdateConnectionSchema,
} from '@/shared/contracts/connections.ts';
import { api, listQuery } from '../../lib/api.ts';

export interface ConnectionFilters {
  orgId?: string | undefined;
  health?: string | undefined;
  q?: string | undefined;
}

export const connectionKeys = {
  all: ['admin', 'connections'] as const,
  list: (f: ConnectionFilters) => ['admin', 'connections', 'list', f] as const,
  detail: (id: string) => ['admin', 'connections', 'detail', id] as const,
  connectors: ['admin', 'connectors'] as const,
};

export function useConnections(filters: ConnectionFilters, enabled = true) {
  return useQuery(
    listQuery({
      queryKey: connectionKeys.list(filters),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get('/api/v1/connections', ConnectionListSchema, {
          query: { ...filters, limit: 200 },
          signal,
        }),
      enabled,
    }),
  );
}

export function useConnection(id: string | undefined) {
  return useQuery({
    queryKey: connectionKeys.detail(id ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/connections/${id}`, ConnectionDetailSchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useConnectors() {
  return useQuery({
    queryKey: connectionKeys.connectors,
    queryFn: ({ signal }) => api.get('/api/v1/connectors', ConnectorListSchema, { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useConnector(type: string | undefined) {
  return useQuery({
    queryKey: [...connectionKeys.connectors, type],
    queryFn: ({ signal }) => api.get(`/api/v1/connectors/${type}`, ConnectorInfoSchema, { signal }),
    enabled: Boolean(type),
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
export function useConnectorNames(): (type: string) => string {
  const list = useConnectors();
  const items = list.data?.items;
  return useMemo(() => {
    const names = new Map((items ?? []).map((c) => [c.type, c.displayName]));
    return (type: string) => names.get(type) ?? type;
  }, [items]);
}
