import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OkSchema } from '@/shared/contracts/common.ts';
import {
  ClaimsResultSchema,
  ClaimsViewSchema,
  type CreateGroup,
  type CreateGroupMember,
  GroupListSchema,
  GroupMemberListSchema,
  GroupMemberSchema,
  GroupResultSchema,
  type GroupRuleInput,
  GroupRuleListSchema,
  GroupRuleSchema,
  type UpdateClaims,
} from '@/shared/contracts/idp-access.ts';
import { api } from '@/web/lib/api.ts';
import { IDP_KEY } from '../../idp/status-queries.ts';

const BASE = '/api/v1/platform/idp/groups';
const at = (key: string, rest = '') => `${BASE}/${encodeURIComponent(key)}${rest}`;
export const groupKeys = {
  list: [...IDP_KEY, 'groups'] as const,
  rules: (key: string) => [...IDP_KEY, 'groups', key, 'rules'] as const,
  members: (key: string) => [...IDP_KEY, 'groups', key, 'members'] as const,
  claims: (key: string) => [...IDP_KEY, 'groups', key, 'claims'] as const,
};

export function useGroups() {
  return useQuery({
    queryKey: groupKeys.list,
    queryFn: ({ signal }) => api.get(BASE, GroupListSchema, { signal }),
  });
}

/** One group of the list; the API has no single-group read. */
export function useGroup(key: string) {
  const query = useGroups();
  return { ...query, data: query.data?.items.find((g) => g.key === key) };
}

export function useGroupRules(key: string) {
  return useQuery({
    queryKey: groupKeys.rules(key),
    queryFn: ({ signal }) => api.get(at(key, '/rules'), GroupRuleListSchema, { signal }),
  });
}

export function useGroupMembers(key: string) {
  return useQuery({
    queryKey: groupKeys.members(key),
    queryFn: ({ signal }) => api.get(at(key, '/members'), GroupMemberListSchema, { signal }),
  });
}

export function useGroupClaims(key: string) {
  return useQuery({
    queryKey: groupKeys.claims(key),
    queryFn: ({ signal }) => api.get(at(key, '/claims'), ClaimsViewSchema, { signal }),
  });
}

/** Every write refreshes the list: counts and sources change with it. */
export function useGroupActions() {
  const client = useQueryClient();
  const refresh = (...extra: (readonly string[])[]) => {
    void client.invalidateQueries({ queryKey: groupKeys.list, exact: true });
    for (const queryKey of extra) void client.invalidateQueries({ queryKey });
  };
  return {
    create: useMutation({
      mutationFn: (body: CreateGroup) => api.post(BASE, GroupResultSchema, body),
      onSuccess: () => refresh(),
    }),
    ensure: useMutation({
      mutationFn: (role: 'console' | 'developer' | 'support') =>
        api.post(`${BASE}/ensure`, GroupResultSchema, { role }),
      onSuccess: () => refresh(),
    }),
    rename: useMutation({
      mutationFn: (v: { key: string; friendlyName: string }) =>
        api.patch(at(v.key), GroupResultSchema, { friendlyName: v.friendlyName }),
      onSuccess: () => refresh(),
    }),
    remove: useMutation({
      mutationFn: (key: string) => api.deleteJson(at(key), GroupResultSchema),
      onSuccess: () => refresh(),
    }),
    addRule: useMutation({
      mutationFn: (v: { key: string; rule: GroupRuleInput }) =>
        api.post(at(v.key, '/rules'), GroupRuleSchema, v.rule),
      onSuccess: (_r, v) => refresh(groupKeys.rules(v.key)),
    }),
    endRule: useMutation({
      mutationFn: (v: { key: string; id: string }) =>
        api.deleteJson(at(v.key, `/rules/${encodeURIComponent(v.id)}`), OkSchema),
      onSuccess: (_r, v) => refresh(groupKeys.rules(v.key)),
    }),
    addMember: useMutation({
      mutationFn: (v: { key: string; member: CreateGroupMember }) =>
        api.post(at(v.key, '/members'), GroupMemberSchema, v.member),
      onSuccess: (_r, v) => refresh(groupKeys.members(v.key)),
    }),
    removeMember: useMutation({
      mutationFn: (v: { key: string; id: string }) =>
        api.deleteJson(at(v.key, `/members/${encodeURIComponent(v.id)}`), OkSchema),
      onSuccess: (_r, v) => refresh(groupKeys.members(v.key)),
    }),
    setClaims: useMutation({
      mutationFn: (v: { key: string; change: UpdateClaims }) =>
        api.patch(at(v.key, '/claims'), ClaimsResultSchema, v.change),
      onSuccess: (_r, v) => refresh(groupKeys.claims(v.key)),
    }),
  };
}
