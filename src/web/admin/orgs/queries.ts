import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  type CreateOrgSchema,
  OrgListSchema,
  OrgSchema,
  OrgSummarySchema,
  type UpdateOrgSchema,
} from '@/shared/contracts/orgs.ts';
import { api, listQuery } from '@/web/lib/api.ts';

export const orgKeys = {
  all: ['orgs'] as const,
  list: ['orgs', 'list'] as const,
  detail: (id: string) => ['orgs', 'detail', id] as const,
};

const orgPath = (id: string) => `/api/v1/orgs/${encodeURIComponent(id)}`;

export function useOrgList(q?: string) {
  return useQuery(
    listQuery({
      queryKey: [...orgKeys.list, q ?? ''],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get('/api/v1/orgs', OrgListSchema, { query: { limit: 200, q }, signal }),
    }),
  );
}

export function useOrg(id: string) {
  return useQuery({
    queryKey: orgKeys.detail(id),
    queryFn: ({ signal }) => api.get(orgPath(id), OrgSummarySchema, { signal }),
  });
}

/** Org id to name for tables with an org column. Falls back to the id while loading. */
export function useOrgNames(): (id: string | null) => string {
  const { data } = useOrgList();
  const names = new Map((data?.items ?? []).map((o) => [o.id, o.name]));
  return (id) => (id === null ? 'Platform' : (names.get(id) ?? id));
}

export function useCreateOrg() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof CreateOrgSchema>) =>
      api.post('/api/v1/orgs', OrgSchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: orgKeys.all }),
  });
}

export function useUpdateOrg(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof UpdateOrgSchema>) => api.patch(orgPath(id), OrgSchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: orgKeys.all }),
  });
}

export function useSetOrgStatus(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (status: 'active' | 'suspended') =>
      api.post(`${orgPath(id)}/status`, OrgSchema, { status }),
    onSuccess: () => client.invalidateQueries({ queryKey: orgKeys.all }),
  });
}

export type BrandingSlot = 'logo' | 'icon';

export function useBrandingImage(id: string) {
  const client = useQueryClient();
  const done = () => client.invalidateQueries({ queryKey: orgKeys.all });
  return {
    upload: useMutation({
      mutationFn: (v: { slot: BrandingSlot; x3: string; x2?: string }) =>
        api.put(`${orgPath(id)}/branding/${v.slot}`, OrgSchema, { x3: v.x3, x2: v.x2 }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (slot: BrandingSlot) =>
        api.delete(`${orgPath(id)}/branding/${slot}`).then(() => slot),
      onSuccess: done,
    }),
  };
}

/** Admin URL of an uploaded image; the sha busts the cache after a new upload. */
export const brandingUrl = (id: string, slot: BrandingSlot, sha: string, scale = '3x') =>
  `${orgPath(id)}/branding/${slot}/${scale}?v=${sha.slice(0, 12)}`;

export function useDeleteOrg(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(orgPath(id)),
    onSuccess: () => client.invalidateQueries({ queryKey: orgKeys.all }),
  });
}
