import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BundleListSchema, BundleSchema } from '@/shared/contracts/bundles.ts';
import { MODE_HEADER, type Mode, OkSchema } from '@/shared/contracts/common.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api } from '../../lib/api.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { sessionQuery } from '../../lib/session.ts';

export const bundleKeys = {
  all: ['admin', 'bundles'] as const,
  ofPass: (passId: string, orgId: string | undefined, mode: Mode) =>
    ['admin', 'bundles', 'pass', passId, orgId, mode] as const,
};

/** The request's mode is the pass's own, not the browser's: a live pass seen in Test mode. */
const inMode = (mode: Mode) => ({ headers: { [MODE_HEADER]: mode } });

/** The bundles a pass is in, listed in the pass's mode and authorized organization. */
export function useBundlesOfPass(passId: string, passOrgId: string, mode: Mode) {
  const scope = useOrgScope();
  const allowed = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      scope.orgId &&
      scope.orgId === passOrgId &&
      scope.membership?.capabilities.includes('passes:read'),
  );
  return useQuery({
    queryKey: bundleKeys.ofPass(passId, allowed ? scope.orgId : undefined, mode),
    queryFn: ({ signal }) => {
      if (!allowed || !scope.orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/bundles', BundleListSchema, {
        query: { orgId: scope.orgId, passId, limit: 50 },
        signal,
        ...inMode(mode),
      });
    },
    enabled: allowed,
  });
}

export interface NewBundle {
  orgId: string;
  passIds: string[];
  name: string;
  holderEmail?: string;
  sendEmail?: boolean;
}

export function useCreateBundle() {
  const qc = useQueryClient();
  const currentUser = () => {
    const session = qc.getQueryData<SessionResponse>(sessionQuery.queryKey);
    return session?.authenticated ? session.user.id : undefined;
  };
  return useMutation({
    mutationFn: (body: NewBundle) => api.post('/api/v1/bundles', BundleSchema, body),
    onMutate: currentUser,
    onSuccess: async (_bundle, _body, userId) => {
      if (userId && currentUser() === userId)
        await qc.invalidateQueries({ queryKey: bundleKeys.all });
    },
  });
}

export function useBundleActions(id: string, mode: Mode) {
  const qc = useQueryClient();
  const currentUser = () => {
    const session = qc.getQueryData<SessionResponse>(sessionQuery.queryKey);
    return session?.authenticated ? session.user.id : undefined;
  };
  const refresh = async (_result: unknown, _input: unknown, userId: string | undefined) => {
    if (userId && currentUser() === userId)
      await qc.invalidateQueries({ queryKey: bundleKeys.all });
  };
  return {
    rotate: useMutation({
      mutationFn: () =>
        api.post(`/api/v1/bundles/${id}/rotate-link`, BundleSchema, undefined, inMode(mode)),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    sendEmail: useMutation({
      mutationFn: () => api.post(`/api/v1/bundles/${id}/send-email`, OkSchema, {}, inMode(mode)),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: () => api.delete(`/api/v1/bundles/${id}`, inMode(mode)),
      onMutate: currentUser,
      onSuccess: refresh,
    }),
  };
}
