import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  ApnsProbeResultSchema,
  IdentityListSchema,
  IdentitySchema,
  type RotateIdentitySchema,
  type UpdateIdentitySchema,
  type UploadIdentitySchema,
} from '@/shared/contracts/identities.ts';
import { BulkReissueResponseSchema } from '@/shared/contracts/passes.ts';
import { api, listQuery } from '@/web/lib/api.ts';

const KEY = ['identities'] as const;
const path = (id: string) => `/api/v1/identities/${encodeURIComponent(id)}`;

/** The Apple identities page: oldest first (the platform identity leads), 50 at a time. */
export function useIdentityPages() {
  return useInfiniteQuery(
    listQuery({
      queryKey: [...KEY, 'pages'],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get('/api/v1/identities', IdentityListSchema, {
          query: { cursor: pageParam, limit: 50 },
          signal,
        }),
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
  );
}

/** Pickers (an org's signing identity): up to 200. */
export function useIdentityOptions() {
  return useQuery({
    queryKey: [...KEY, 'options'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/identities', IdentityListSchema, { query: { limit: 200 }, signal }),
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

export function useCheckApns(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`${path(id)}/apns-check`, ApnsProbeResultSchema, {}),
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
