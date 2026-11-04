import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BundleListSchema, BundleSchema } from '@/shared/contracts/bundles.ts';
import { OkSchema } from '@/shared/contracts/common.ts';
import { api } from '../../lib/api.ts';

export const bundleKeys = {
  all: ['admin', 'bundles'] as const,
  ofPass: (passId: string) => ['admin', 'bundles', 'pass', passId] as const,
};

/** The bundles a pass is in (the caller's mode). */
export function useBundlesOfPass(passId: string) {
  return useQuery({
    queryKey: bundleKeys.ofPass(passId),
    queryFn: ({ signal }) =>
      api.get('/api/v1/bundles', BundleListSchema, { query: { passId, limit: 50 }, signal }),
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

export function useBundleActions(id: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: bundleKeys.all });
  return {
    rotate: useMutation({
      mutationFn: () => api.post(`/api/v1/bundles/${id}/rotate-link`, BundleSchema),
      onSuccess: refresh,
    }),
    sendEmail: useMutation({
      mutationFn: () => api.post(`/api/v1/bundles/${id}/send-email`, OkSchema, {}),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: () => api.delete(`/api/v1/bundles/${id}`),
      onSuccess: refresh,
    }),
  };
}
