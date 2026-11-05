import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BundleListSchema, BundleSchema } from '@/shared/contracts/bundles.ts';
import { MODE_HEADER, type Mode, OkSchema } from '@/shared/contracts/common.ts';
import { api } from '../../lib/api.ts';

export const bundleKeys = {
  all: ['admin', 'bundles'] as const,
  ofPass: (passId: string, mode: Mode) => ['admin', 'bundles', 'pass', passId, mode] as const,
};

/** The request's mode is the pass's own, not the browser's: a live pass seen in Test mode. */
const inMode = (mode: Mode) => ({ headers: { [MODE_HEADER]: mode } });

/** The bundles a pass is in, listed in the pass's mode. */
export function useBundlesOfPass(passId: string, mode: Mode) {
  return useQuery({
    queryKey: bundleKeys.ofPass(passId, mode),
    queryFn: ({ signal }) =>
      api.get('/api/v1/bundles', BundleListSchema, {
        query: { passId, limit: 50 },
        signal,
        ...inMode(mode),
      }),
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
  return useMutation({
    mutationFn: (body: NewBundle) => api.post('/api/v1/bundles', BundleSchema, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: bundleKeys.all }),
  });
}

export function useBundleActions(id: string, mode: Mode) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: bundleKeys.all });
  return {
    rotate: useMutation({
      mutationFn: () =>
        api.post(`/api/v1/bundles/${id}/rotate-link`, BundleSchema, undefined, inMode(mode)),
      onSuccess: refresh,
    }),
    sendEmail: useMutation({
      mutationFn: () => api.post(`/api/v1/bundles/${id}/send-email`, OkSchema, {}, inMode(mode)),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: () => api.delete(`/api/v1/bundles/${id}`, inMode(mode)),
      onSuccess: refresh,
    }),
  };
}
