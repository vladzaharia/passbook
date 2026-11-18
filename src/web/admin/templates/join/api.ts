import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Mode } from '@/shared/contracts/common.ts';
import {
  type JoinLinkState,
  JoinLinkStateSchema,
  type JoinLinkUpdate,
} from '@/shared/contracts/join.ts';
import { api } from '../../../lib/api.ts';

export interface JoinScope {
  templateId: string;
  /** Sent only for a platform template: an org template names its own org. */
  orgId: string | undefined;
  mode: Mode;
}

const key = ({ templateId, orgId, mode }: JoinScope) =>
  ['admin', 'join-link', templateId, orgId ?? null, mode] as const;
const base = (templateId: string) => `/api/v1/join-links/${encodeURIComponent(templateId)}`;
const query = (s: JoinScope) => (s.orgId ? { orgId: s.orgId } : undefined);

/** The template's link in the console's mode, with whether it can be turned on. */
export function useJoinLink(scope: JoinScope, enabled = true) {
  return useQuery({
    queryKey: key(scope),
    queryFn: ({ signal }) =>
      api.get(base(scope.templateId), JoinLinkStateSchema, { query: query(scope), signal }),
    enabled,
  });
}

/** Writes answer with the new state; a stale revision is a 409 the caller shows and reloads from. */
export function useJoinLinkActions(scope: JoinScope) {
  const client = useQueryClient();
  const settle = (state: JoinLinkState) => client.setQueryData(key(scope), state);
  const refresh = () => client.invalidateQueries({ queryKey: key(scope) });
  const update = useMutation({
    mutationFn: (body: JoinLinkUpdate) =>
      api.put(base(scope.templateId), JoinLinkStateSchema, body, { query: query(scope) }),
    onSuccess: settle,
    onError: refresh,
  });
  const rotate = useMutation({
    mutationFn: () =>
      api.post(`${base(scope.templateId)}/rotate`, JoinLinkStateSchema, undefined, {
        query: query(scope),
      }),
    onSuccess: settle,
    onError: refresh,
  });
  return { update, rotate };
}
