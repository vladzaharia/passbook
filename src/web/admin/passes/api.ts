import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AuditListSchema } from '@/shared/contracts/audit.ts';
import { OkSchema } from '@/shared/contracts/common.ts';
import { HolderSchema } from '@/shared/contracts/holders.ts';
import {
  PassActionResponseSchema,
  PassAssetListSchema,
  PassAssetSchema,
  PassDetailSchema,
  PassListSchema,
  RefreshPassResponseSchema,
  RotateLinkResponseSchema,
} from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';

export interface PassFilters {
  q?: string | undefined;
  orgId?: string | undefined;
  templateId?: string | undefined;
  connectionId?: string | undefined;
  status?: 'active' | 'voided' | undefined;
  holderState?: 'unassigned' | 'waiting' | 'owned' | undefined;
}

/** Body of PUT /passes/{id}/connection; null ids unbind. */
export interface BindConnectionBody {
  connectionId: string | null;
  externalRef: string | null;
  resetFieldSources?: boolean;
}

export const passKeys = {
  all: ['admin', 'passes'] as const,
  list: (f: PassFilters) => ['admin', 'passes', 'list', f] as const,
  detail: (id: string) => ['admin', 'passes', 'detail', id] as const,
  version: (id: string, v: number) => ['admin', 'passes', 'version', id, v] as const,
  assets: (id: string) => ['admin', 'passes', 'assets', id] as const,
  audit: (id: string) => ['admin', 'passes', 'audit', id] as const,
};

export function usePassList(filters: PassFilters) {
  return useInfiniteQuery({
    queryKey: passKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/passes', PassListSchema, {
        query: { ...filters, cursor: pageParam, limit: 50 },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function usePass(id: string) {
  return useQuery({
    queryKey: passKeys.detail(id),
    queryFn: ({ signal }) => api.get(`/api/v1/passes/${id}`, PassDetailSchema, { signal }),
  });
}

/** A retained version, for rendering. Disabled while `version` is undefined. */
export function usePassVersion(id: string, version: number | undefined) {
  return useQuery({
    queryKey: passKeys.version(id, version ?? -1),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/${id}/versions/${version}`, PassDetailSchema, { signal }),
    enabled: version !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const DiffSchema = z.object({
  changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
});

export function usePassDiff(id: string, from: number | undefined, to: number | undefined) {
  return useQuery({
    queryKey: ['admin', 'passes', 'diff', id, from, to],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/${id}/diff`, DiffSchema, { query: { from, to }, signal }),
    enabled: from !== undefined && to !== undefined && from !== to,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function usePassAssets(id: string) {
  return useQuery({
    queryKey: passKeys.assets(id),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/${id}/assets`, PassAssetListSchema, { signal }),
  });
}

export function usePassAudit(id: string, enabled: boolean) {
  return useQuery({
    queryKey: passKeys.audit(id),
    queryFn: ({ signal }) =>
      api.get('/api/v1/audit', AuditListSchema, {
        query: { targetType: 'pass', targetId: id, limit: 50 },
        signal,
      }),
    enabled,
  });
}

/** Mutations that change a pass all end by refetching its detail and the lists. */
export function usePassActions(id: string) {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: passKeys.all });
  };
  return {
    setVoided: useMutation({
      mutationFn: (voided: boolean) =>
        api.post(`/api/v1/passes/${id}/${voided ? 'void' : 'unvoid'}`, PassActionResponseSchema),
      onSuccess: refresh,
    }),
    refreshFromSource: useMutation({
      mutationFn: () => api.post(`/api/v1/passes/${id}/refresh`, RefreshPassResponseSchema),
      onSuccess: refresh,
    }),
    rotateLink: useMutation({
      mutationFn: () => api.post(`/api/v1/passes/${id}/rotate-link`, RotateLinkResponseSchema),
      onSuccess: refresh,
    }),
    resendEmail: useMutation({
      mutationFn: (input: { to?: string; attach?: boolean; key: string }) =>
        api.post(
          `/api/v1/passes/${id}/resend-email`,
          OkSchema,
          {
            ...(input.to ? { to: input.to } : {}),
            ...(input.attach ? { attach: true } : {}),
          },
          { headers: { 'idempotency-key': input.key } },
        ),
      onSuccess: refresh,
    }),
    bindConnection: useMutation({
      mutationFn: (body: BindConnectionBody) =>
        api.put(`/api/v1/passes/${id}/connection`, PassDetailSchema, body),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: () => api.delete(`/api/v1/passes/${id}`),
      onSuccess: async () => {
        qc.removeQueries({ queryKey: passKeys.detail(id) });
        await qc.invalidateQueries({ queryKey: ['admin', 'passes', 'list'] });
      },
    }),
    reassign: useMutation({
      mutationFn: (email: string | null) =>
        api.post('/api/v1/holders/reassign', HolderSchema, { passId: id, email }),
      onSuccess: refresh,
    }),
    assign: useMutation({
      mutationFn: (email: string) =>
        api.post('/api/v1/holders/assign', HolderSchema, { passId: id, email }),
      onSuccess: refresh,
    }),
    clearBlock: useMutation({
      mutationFn: (userId: string) =>
        api.post('/api/v1/holders/clear-block', OkSchema, { passId: id, userId }),
      onSuccess: refresh,
    }),
    unassign: useMutation({
      mutationFn: () => api.post('/api/v1/holders/unassign', HolderSchema, { passId: id }),
      onSuccess: refresh,
    }),
    uploadAsset: useMutation({
      mutationFn: ({ name, file }: { name: string; file: Blob }) =>
        api.put(`/api/v1/passes/${id}/assets/${name}`, PassAssetSchema, file),
      onSuccess: () => qc.invalidateQueries({ queryKey: passKeys.assets(id) }),
    }),
    removeAsset: useMutation({
      mutationFn: (name: string) => api.delete(`/api/v1/passes/${id}/assets/${name}`),
      onSuccess: () => qc.invalidateQueries({ queryKey: passKeys.assets(id) }),
    }),
  };
}
