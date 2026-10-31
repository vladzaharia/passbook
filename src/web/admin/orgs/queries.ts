import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  type CreateOrgSchema,
  OrgListSchema,
  OrgSchema,
  OrgSummarySchema,
  type UpdateOrgSchema,
} from '@/shared/contracts/orgs.ts';
import { api } from '@/web/lib/api.ts';

export const orgKeys = {
  all: ['orgs'] as const,
  list: ['orgs', 'list'] as const,
  detail: (id: string) => ['orgs', 'detail', id] as const,
};

export function useOrgList() {
  return useQuery({
    queryKey: orgKeys.list,
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs', OrgListSchema, { query: { limit: 200 }, signal }),
  });
}

export function useOrg(id: string) {
  return useQuery({
    queryKey: orgKeys.detail(id),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/orgs/${encodeURIComponent(id)}`, OrgSummarySchema, { signal }),
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
    mutationFn: (body: z.input<typeof UpdateOrgSchema>) =>
      api.patch(`/api/v1/orgs/${encodeURIComponent(id)}`, OrgSchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: orgKeys.all }),
  });
}

export function useDeleteOrg(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/api/v1/orgs/${encodeURIComponent(id)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: orgKeys.all }),
  });
}
