import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { OrgInvitationSchema } from '@/shared/contracts/org-membership.ts';
import {
  type CreateOrgSchema,
  OrgListSchema,
  OrgSchema,
  OrgSummarySchema,
  PlatformOrgSummarySchema,
  type UpdateOrgSchema,
} from '@/shared/contracts/orgs.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api, listQuery } from '@/web/lib/api.ts';
import { sessionQuery } from '@/web/lib/session.ts';

/** Platform provisioning deliberately excludes tenant branding, settings, and identity. */
export const PlatformOrgSchema = OrgSchema.pick({
  id: true,
  slug: true,
  name: true,
  status: true,
  personal: true,
  createdAt: true,
});
export { PlatformOrgSummarySchema };
export const PlatformOrgListSchema = OrgListSchema.extend({
  items: z.array(PlatformOrgSummarySchema),
});

export const orgKeys = {
  all: ['orgs'] as const,
  list: ['orgs', 'list'] as const,
  detail: (id: string) => ['orgs', 'detail', id] as const,
  workspace: (id: string) => ['orgs', 'workspace', id] as const,
};

const orgPath = (id: string) => `/api/v1/orgs/${encodeURIComponent(id)}`;

/** Platform directory names: one request for up to 200 organizations. */
export function useOrgList() {
  return useQuery(
    listQuery({
      queryKey: [...orgKeys.list, ''],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get('/api/v1/orgs', PlatformOrgListSchema, { query: { limit: 200 }, signal }),
    }),
  );
}

export function useOrg(id: string) {
  return useQuery({
    queryKey: orgKeys.detail(id),
    queryFn: ({ signal }) => api.get(orgPath(id), PlatformOrgSummarySchema, { signal }),
  });
}

export function useOrgWorkspace(id: string, enabled = true) {
  return useQuery({
    queryKey: orgKeys.workspace(id),
    queryFn: ({ signal }) => api.get(`${orgPath(id)}/workspace`, OrgSummarySchema, { signal }),
    enabled,
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

/** Reloads every org query: the stale-save pattern refetches the current values. */
export function useRefreshOrgs() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: orgKeys.all });
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
      api.post(`${orgPath(id)}/status`, PlatformOrgSchema, { status }),
    onSuccess: () => client.invalidateQueries({ queryKey: orgKeys.all }),
  });
}

/** Platform bootstrap invites an administrator without granting the caller a membership. */
export function useInviteOrgAdmin(id: string) {
  const client = useQueryClient();
  const isCurrentPrincipal = (principalId: string) => {
    const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    return session?.authenticated === true && session.user.id === principalId;
  };
  return useMutation({
    mutationFn: async ({ email, principalId }: { email: string; principalId: string }) => {
      if (!isCurrentPrincipal(principalId)) return undefined;
      try {
        await api.post(`${orgPath(id)}/invitations`, OrgInvitationSchema, {
          email,
          roles: ['org_admin'],
        });
        if (isCurrentPrincipal(principalId)) return true;
      } catch (error) {
        if (isCurrentPrincipal(principalId)) throw error;
      }
      return undefined;
    },
    onSuccess: (sent, { principalId }) => {
      if (sent && isCurrentPrincipal(principalId)) {
        return client.invalidateQueries({ queryKey: ['org-access', id] });
      }
      return undefined;
    },
  });
}

export type BrandingSlot = 'logo' | 'icon';

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
