import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  AccessViewSchema,
  ClaimsResultSchema,
  ClaimsViewSchema,
  GroupListSchema,
  GroupMemberListSchema,
  GroupMemberSchema,
  IdpStatusSchema,
  type OffboardPlan,
  OffboardStartedSchema,
  type UpdateClaims,
} from '@/shared/contracts/idp-access.ts';
import type { IdpRoleSchema } from '@/shared/contracts/idp-ops.ts';
import { StartedOperationSchema } from '@/shared/contracts/operations.ts';
import { api } from '@/web/lib/api.ts';
import { trackOperation } from '@/web/ui/operation/index.ts';

type Role = z.infer<typeof IdpRoleSchema>;
const userPath = (id: string) => `/api/v1/users/${encodeURIComponent(id)}`;
const groupPath = (key: string) => `/api/v1/platform/idp/groups/${encodeURIComponent(key)}`;

const accessKey = (id: string) => ['idp', 'access', id] as const;
const claimsKey = (id: string) => ['idp', 'claims', id] as const;

/** Polaris ID is optional: a binding that is absent or unreachable answers an error, and every surface using this hides. */
export function useAccess(userId: string) {
  const query = useQuery({
    queryKey: accessKey(userId),
    queryFn: ({ signal }) => api.get(`${userPath(userId)}/access`, AccessViewSchema, { signal }),
    retry: false,
  });
  return { ...query, available: query.data?.connected === true };
}

/** True when the binding is connected: the Users page offers Invite only then. */
export function useIdpConnected(): boolean {
  const query = useQuery({
    queryKey: ['idp', 'status'],
    queryFn: ({ signal }) => api.get('/api/v1/platform/idp', IdpStatusSchema, { signal }),
    retry: false,
    staleTime: 60_000,
  });
  return query.data?.connected === true;
}

/** Starts an operation the page then shows: it lands in the tray and the page's `?op` panel. */
export function useAccessActions(userId: string, onStarted: (id: string) => void) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: accessKey(userId) }),
      client.invalidateQueries({ queryKey: ['users'] }),
    ]);
  const started = (result: { operation: Parameters<typeof trackOperation>[0] | null }) => {
    if (!result.operation) return;
    trackOperation(result.operation);
    onStarted(result.operation.id);
  };
  return {
    grant: useMutation({
      mutationFn: (v: { role: 'developer' | 'support'; grant: boolean }) =>
        api.post(`${userPath(userId)}/roles`, AccessViewSchema, v),
      onSuccess: (data) => {
        client.setQueryData(accessKey(userId), data);
        void refresh();
      },
    }),
    removeExternal: useMutation({
      mutationFn: (role: Role) =>
        api.post(`${userPath(userId)}/roles/${role}/remove-external`, AccessViewSchema),
      onSuccess: (data) => {
        client.setQueryData(accessKey(userId), data);
        void refresh();
      },
    }),
    restore: useMutation({
      mutationFn: (role: Role) =>
        api.deleteJson(`${userPath(userId)}/holds/${role}`, StartedOperationSchema),
      onSuccess: started,
    }),
    plan: useMutation({
      mutationFn: async (): Promise<OffboardPlan> =>
        (await api.post(`${userPath(userId)}/offboard`, OffboardStartedSchema, { dryRun: true }))
          .plan,
    }),
    offboard: useMutation({
      mutationFn: () =>
        api.post(`${userPath(userId)}/offboard`, OffboardStartedSchema, { dryRun: false }),
      onSuccess: started,
    }),
    refresh,
  };
}

export function useClaims(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: claimsKey(userId),
    enabled,
    retry: false,
    queryFn: ({ signal }) => api.get(`${userPath(userId)}/claims`, ClaimsViewSchema, { signal }),
  });
}

export function useSetClaims(userId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateClaims) =>
      api.patch(`${userPath(userId)}/claims`, ClaimsResultSchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: claimsKey(userId) }),
  });
}

/** One group the user is a manual member of, with the row to remove. */
export interface UserGroup {
  key: string;
  label: string;
  memberId: string;
}
export interface GroupChoice {
  key: string;
  label: string;
}

/**
 * The custom and adopted groups, and which of them hold the user by hand. Org rules show on the group's own page:
 * the groups API lists manual members only.
 */
export function useUserGroups(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['idp', 'user-groups', userId],
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      const list = await api.get('/api/v1/platform/idp/groups', GroupListSchema, { signal });
      const groups = list.items.filter((g) => g.kind !== 'role');
      const label = (g: (typeof groups)[number]) => g.friendlyName ?? g.name;
      const held = await Promise.all(
        groups.map(async (g) => {
          const members = await api.get(`${groupPath(g.key)}/members`, GroupMemberListSchema, {
            signal,
          });
          const mine = members.items.find((m) => m.userId === userId);
          return mine ? ({ key: g.key, label: label(g), memberId: mine.id } as UserGroup) : null;
        }),
      );
      return {
        choices: groups
          .filter((g) => !g.flags.length)
          .map((g): GroupChoice => ({ key: g.key, label: label(g) })),
        held: held.filter((g): g is UserGroup => g !== null),
      };
    },
  });
}

export function useGroupMembership(userId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['idp', 'user-groups', userId] });
  return {
    add: useMutation({
      mutationFn: (key: string) =>
        api.post(`${groupPath(key)}/members`, GroupMemberSchema, { userId }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (g: UserGroup) => api.delete(`${groupPath(g.key)}/members/${g.memberId}`),
      onSuccess: refresh,
    }),
  };
}
