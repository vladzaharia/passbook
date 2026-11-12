import {
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import { AuditListSchema } from '@/shared/contracts/audit.ts';
import { OkSchema } from '@/shared/contracts/common.ts';
import { HolderSchema } from '@/shared/contracts/holders.ts';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import {
  BulkPassActionResponseSchema,
  PassActionResponseSchema,
  PassAssetListSchema,
  PassAssetSchema,
  PassDetailSchema,
  PassListSchema,
  type PassListStatusSchema,
  type PassSummaryDto,
  RefreshPassResponseSchema,
  RotateLinkResponseSchema,
} from '@/shared/contracts/passes.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api } from '../../lib/api.ts';
import { getMode } from '../../lib/mode.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { membershipsQuery, sessionQuery } from '../../lib/session.ts';

export interface PassFilters {
  q?: string | undefined;
  orgId?: string | undefined;
  templateId?: string | undefined;
  connectionId?: string | undefined;
  status?: z.infer<typeof PassListStatusSchema> | undefined;
  holderState?: 'unassigned' | 'waiting' | 'owned' | undefined;
  onDevice?: 'true' | 'false' | undefined;
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
  holder: (id: string, orgId: string | undefined) =>
    ['admin', 'passes', 'holder', id, orgId] as const,
  version: (id: string, v: number) => ['admin', 'passes', 'version', id, v] as const,
  assets: (id: string) => ['admin', 'passes', 'assets', id] as const,
  audit: (id: string, orgId: string | undefined) =>
    ['admin', 'passes', 'audit', id, orgId] as const,
};

/** The principal that initiated a pass mutation must still own its completion. */
export function passMutationPrincipal(client: QueryClient): string | undefined {
  const state = client.getQueryState<SessionResponse>(sessionQuery.queryKey);
  const session = state?.status === 'success' ? state.data : undefined;
  return session?.authenticated ? session.user.id : undefined;
}

/** Recheck authority after asynchronous file preparation or between successive requests. */
export function canMutatePass(
  client: QueryClient,
  pass: Pick<PassSummaryDto, 'orgId' | 'mode'>,
  principalId: string,
): boolean {
  if (passMutationPrincipal(client) !== principalId || getMode() !== pass.mode) return false;
  const state = client.getQueryState<{ items: OrgMembership[] }>(membershipsQuery.queryKey);
  const grants = state?.status === 'success' ? state.data : undefined;
  return (
    grants?.items.some(
      (membership) =>
        membership.userId === principalId &&
        membership.orgId === pass.orgId &&
        membership.revokedAt === null &&
        membership.capabilities.includes('passes:operate'),
    ) ?? false
  );
}

export function usePassList(filters: PassFilters) {
  const scope = useOrgScope();
  const allowed = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      filters.orgId &&
      filters.orgId === scope.orgId &&
      scope.membership?.capabilities.includes('passes:read'),
  );
  return useInfiniteQuery({
    queryKey: passKeys.list({ ...filters, orgId: allowed ? scope.orgId : undefined }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => {
      if (!allowed || !scope.orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/passes', PassListSchema, {
        query: { ...filters, orgId: scope.orgId, cursor: pageParam, limit: 50 },
        signal,
      });
    },
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    enabled: allowed,
    // Keep filtered rows only while the selected, authorized organization stays the same.
    placeholderData: (previous, query) =>
      allowed && query?.queryKey[3].orgId === scope.orgId ? previous : undefined,
  });
}

/** Void or email up to 100 passes of one org; each is audited on its own. */
export function useBulkPassAction() {
  const qc = useQueryClient();
  const currentUser = () => passMutationPrincipal(qc);
  return useMutation({
    mutationFn: (body: {
      action: 'void' | 'send_email' | 'remove';
      ids: string[];
      message?: string;
      orgId?: string;
      /** One key per intent: a retry of the same selection cannot email twice. */
      key?: string;
    }) => {
      const { key, ...rest } = body;
      return api.post(
        '/api/v1/passes/bulk',
        BulkPassActionResponseSchema,
        rest,
        key ? { headers: { 'idempotency-key': key } } : undefined,
      );
    },
    onMutate: currentUser,
    onSuccess: async (_result, _body, userId) => {
      if (userId && currentUser() === userId)
        await qc.invalidateQueries({ queryKey: passKeys.all });
    },
  });
}

export const passDetailQuery = (id: string) =>
  queryOptions({
    queryKey: passKeys.detail(id),
    queryFn: ({ signal }) => api.get(`/api/v1/passes/${id}`, PassDetailSchema, { signal }),
  });

export function usePass(id: string, freshOnMount = false) {
  return useQuery({
    ...passDetailQuery(id),
    ...(freshOnMount ? { staleTime: 0, refetchOnMount: 'always' as const } : {}),
  });
}

export function usePassAssets(id: string) {
  return useQuery({
    queryKey: passKeys.assets(id),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/passes/${id}/assets`, PassAssetListSchema, { signal }),
  });
}

export function usePassAudit(id: string, passOrgId: string, enabled: boolean) {
  const scope = useOrgScope();
  const allowed = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      scope.orgId &&
      scope.orgId === passOrgId &&
      scope.membership?.capabilities.includes('audit:read'),
  );
  return useQuery({
    queryKey: passKeys.audit(id, allowed ? scope.orgId : undefined),
    queryFn: ({ signal }) => {
      if (!allowed || !scope.orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/audit', AuditListSchema, {
        query: { orgId: scope.orgId, targetType: 'pass', targetId: id, limit: 50 },
        signal,
      });
    },
    enabled: enabled && allowed,
  });
}

/** Holder transfer status is independently observable while native retirement runs. */
export function usePassHolder(id: string, passOrgId: string) {
  const scope = useOrgScope();
  const allowed = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      scope.orgId === passOrgId &&
      scope.membership?.capabilities.includes('passes:read'),
  );
  return useQuery({
    queryKey: passKeys.holder(id, allowed ? scope.orgId : undefined),
    queryFn: ({ signal }) => api.get(`/api/v1/holders/${id}`, HolderSchema, { signal }),
    enabled: allowed,
    refetchInterval: (query) => (query.state.data?.transfer?.state === 'pending' ? 5_000 : false),
  });
}

/** Mutations that change a pass all end by refetching its detail and the lists. */
export function usePassActions(id: string) {
  const qc = useQueryClient();
  const currentUser = () => passMutationPrincipal(qc);
  const refresh = async (_result: unknown, _input: unknown, userId: string | undefined) => {
    if (userId && currentUser() === userId) await qc.invalidateQueries({ queryKey: passKeys.all });
  };
  const refreshAssets = async (_result: unknown, _input: unknown, userId: string | undefined) => {
    if (userId && currentUser() === userId) {
      await qc.invalidateQueries({ queryKey: passKeys.assets(id) });
    }
  };
  return {
    setVoided: useMutation({
      mutationFn: (voided: boolean) =>
        api.post(`/api/v1/passes/${id}/${voided ? 'void' : 'unvoid'}`, PassActionResponseSchema),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    refreshFromSource: useMutation({
      mutationFn: () => api.post(`/api/v1/passes/${id}/refresh`, RefreshPassResponseSchema),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    rotateLink: useMutation({
      mutationFn: () => api.post(`/api/v1/passes/${id}/rotate-link`, RotateLinkResponseSchema),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    resendEmail: useMutation({
      mutationFn: (input: { to?: string | undefined; attach?: boolean; key: string }) =>
        api.post(
          `/api/v1/passes/${id}/resend-email`,
          OkSchema,
          {
            ...(input.to ? { to: input.to } : {}),
            ...(input.attach ? { attach: true } : {}),
          },
          { headers: { 'idempotency-key': input.key } },
        ),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    bindConnection: useMutation({
      mutationFn: (body: BindConnectionBody) =>
        api.put(`/api/v1/passes/${id}/connection`, PassDetailSchema, body),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: () => api.delete(`/api/v1/passes/${id}`),
      onMutate: currentUser,
      onSuccess: async (_result, _input, userId) => {
        if (!userId || currentUser() !== userId) return;
        qc.removeQueries({ queryKey: passKeys.detail(id) });
        if (currentUser() !== userId) return;
        await qc.invalidateQueries({ queryKey: ['admin', 'passes', 'list'] });
      },
    }),
    reassign: useMutation({
      mutationFn: (email: string | null) =>
        api.post('/api/v1/holders/reassign', HolderSchema, { passId: id, email }),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    assign: useMutation({
      mutationFn: (email: string) =>
        api.post('/api/v1/holders/assign', HolderSchema, { passId: id, email }),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    clearBlock: useMutation({
      mutationFn: (userId: string) =>
        api.post('/api/v1/holders/clear-block', OkSchema, { passId: id, userId }),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    unassign: useMutation({
      mutationFn: () => api.post('/api/v1/holders/unassign', HolderSchema, { passId: id }),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    uploadAsset: useMutation({
      mutationFn: ({ name, file }: { name: string; file: Blob }) =>
        api.put(`/api/v1/passes/${id}/assets/${name}`, PassAssetSchema, file),
      onMutate: currentUser,
      onSuccess: refreshAssets,
    }),
    removeAsset: useMutation({
      mutationFn: (name: string) => api.delete(`/api/v1/passes/${id}/assets/${name}`),
      onMutate: currentUser,
      onSuccess: refreshAssets,
    }),
  };
}

/** Remove from Wallet and its undo; both end by refetching the pass, its devices and its log. */
export function usePassRemoval(id: string) {
  const qc = useQueryClient();
  const currentUser = () => passMutationPrincipal(qc);
  const refresh = async (_result: unknown, _input: unknown, userId: string | undefined) => {
    if (userId && currentUser() === userId) await qc.invalidateQueries({ queryKey: passKeys.all });
  };
  return {
    remove: useMutation({
      mutationFn: (message: string | undefined) =>
        api.post(`/api/v1/passes/${id}/remove`, PassActionResponseSchema, { message }),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    restore: useMutation({
      mutationFn: () => api.post(`/api/v1/passes/${id}/restore`, PassActionResponseSchema),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
  };
}
