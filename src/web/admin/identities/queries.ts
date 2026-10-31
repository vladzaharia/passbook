import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  IdentityListSchema,
  IdentitySchema,
  type RotateIdentitySchema,
  type UpdateIdentitySchema,
  type UploadIdentitySchema,
} from '@/shared/contracts/identities.ts';
import { BulkReissueResponseSchema } from '@/shared/contracts/passes.ts';
import { api } from '@/web/lib/api.ts';

const KEY = ['identities'] as const;
const path = (id: string) => `/api/v1/identities/${encodeURIComponent(id)}`;

export function useIdentities() {
  return useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: ({ signal }) => api.get('/api/v1/identities', IdentityListSchema, { signal }),
  });
}

export function useIdentity(id: string) {
  return useQuery({
    queryKey: [...KEY, 'detail', id],
    queryFn: ({ signal }) => api.get(path(id), IdentitySchema, { signal }),
  });
}

export function useUploadIdentity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof UploadIdentitySchema>) =>
      api.post('/api/v1/identities', IdentitySchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateIdentity(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof UpdateIdentitySchema>) =>
      api.patch(path(id), IdentitySchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteIdentity(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(path(id)),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRotateIdentity(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof RotateIdentitySchema>) =>
      api.post(`${path(id)}/rotate`, IdentitySchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });
}

/** Rebuilds and re-signs every pass of the identity across templates, without pushes. */
export function useResignIdentityPasses(identityId: string) {
  return useMutation({
    mutationFn: () =>
      api.post('/api/v1/passes/bulk-reissue', BulkReissueResponseSchema, {
        cause: 'resign',
        identityId,
      }),
  });
}
