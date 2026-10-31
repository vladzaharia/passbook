import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { api } from '../../lib/api.ts';

export interface ConnectionFilters {
  orgId?: string | undefined;
  health?: string | undefined;
}

export const connectionKeys = {
  all: ['admin', 'connections'] as const,
  list: (f: ConnectionFilters) => ['admin', 'connections', 'list', f] as const,
  detail: (id: string) => ['admin', 'connections', 'detail', id] as const,
  connectors: ['admin', 'connectors'] as const,
};

export function useConnections(filters: ConnectionFilters, enabled = true) {
  return useQuery({
    queryKey: connectionKeys.list(filters),
    queryFn: ({ signal }) =>
      api.get('/api/v1/connections', ConnectionListSchema, {
        query: { ...filters, limit: 200 },
        signal,
      }),
    enabled,
  });
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
  const done = () => qc.invalidateQueries({ queryKey: connectionKeys.all });
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
