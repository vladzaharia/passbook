import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { ScannerSchema } from '@/shared/contracts/scanners.ts';
import {
  CreatedScanningDeviceSchema,
  type CreateScanningDeviceSchema,
  type CreateScanningSessionSchema,
  ScanningDeviceSchema,
  ScanningSessionDetailSchema,
  ScanningSessionListSchema,
  type UpdateScanningDeviceSchema,
  type UpdateScanningSessionSchema,
} from '@/shared/contracts/scanning-sessions.ts';
import { api } from '@/web/lib/api.ts';
import { scanningKeys } from '../queries.ts';

export const sessionKeys = {
  all: ['admin', 'scanning', 'sessions'] as const,
  list: (orgId?: string) => ['admin', 'scanning', 'sessions', 'list', orgId] as const,
  detail: (id: string) => ['admin', 'scanning', 'sessions', 'detail', id] as const,
};
export function useScanningSessions(orgId?: string) {
  return useInfiniteQuery({
    queryKey: sessionKeys.list(orgId),
    initialPageParam: undefined as string | undefined,
    refetchInterval: 5_000,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/scanning-sessions', ScanningSessionListSchema, {
        query: { orgId, cursor: pageParam, limit: 50 },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
export function useScanningSession(id: string) {
  return useQuery({
    queryKey: sessionKeys.detail(id),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/scanning-sessions/${id}`, ScanningSessionDetailSchema, { signal }),
    refetchInterval: 5_000,
  });
}
function useRefreshSessions() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: sessionKeys.all }),
      client.invalidateQueries({ queryKey: scanningKeys.scanners }),
    ]);
}
export function useCreateSession() {
  const refresh = useRefreshSessions();
  return useMutation({
    mutationFn: (body: z.input<typeof CreateScanningSessionSchema>) =>
      api.post('/api/v1/scanning-sessions', ScanningSessionDetailSchema, body),
    onSuccess: refresh,
  });
}
export function useUpdateSession(id: string) {
  const refresh = useRefreshSessions();
  return useMutation({
    mutationFn: (body: z.input<typeof UpdateScanningSessionSchema>) =>
      api.patch(`/api/v1/scanning-sessions/${id}`, ScanningSessionDetailSchema, body),
    onSuccess: refresh,
  });
}
export function useAddSessionDevice(id: string) {
  const refresh = useRefreshSessions();
  return useMutation({
    mutationFn: (body: z.input<typeof CreateScanningDeviceSchema>) =>
      api.post(`/api/v1/scanning-sessions/${id}/devices`, CreatedScanningDeviceSchema, body),
    onSuccess: refresh,
  });
}
export function useUpdateSessionDevice(sessionId: string, id: string) {
  const refresh = useRefreshSessions();
  return useMutation({
    mutationFn: (body: z.input<typeof UpdateScanningDeviceSchema>) =>
      api.patch(`/api/v1/scanning-sessions/${sessionId}/devices/${id}`, ScanningDeviceSchema, body),
    onSuccess: refresh,
  });
}
export function useRevokeSessionDevice(id: string) {
  const refresh = useRefreshSessions();
  return useMutation({
    mutationFn: () => api.post(`/api/v1/scanners/${id}/revoke`, ScannerSchema),
    onSuccess: refresh,
  });
}
