import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DeveloperInvitationSchema,
  DeveloperListSchema,
} from '@/shared/contracts/developer-invitations.ts';
import {
  OrgInvitationListSchema,
  OrgInvitationSchema,
  OrgMemberListSchema,
  OrgMemberSchema,
  type OrgRole,
} from '@/shared/contracts/org-membership.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api } from '@/web/lib/api.ts';
import { membershipsQuery, sessionQuery, useSession } from '@/web/lib/session.ts';

export type InviteBody = { email: string; roles: OrgRole[]; developer?: boolean };
/** Sends one invitation; true when it went. A thrown error is the server's refusal. */
export type SendInvite = (body: InviteBody) => Promise<boolean>;

/** Members and invitations of one org, and the writes the Members page makes. */
export function useOrgAccess(orgId: string, personal = false) {
  const path = `/api/v1/orgs/${encodeURIComponent(orgId)}`;
  const key = ['org-access', orgId];
  const client = useQueryClient();
  const { authed } = useSession();
  const members = useQuery({
    queryKey: [...key, 'memberships'],
    queryFn: ({ signal }) => api.get(`${path}/memberships`, OrgMemberListSchema, { signal }),
  });
  const invitations = useQuery({
    queryKey: [...key, 'invitations'],
    queryFn: ({ signal }) => api.get(`${path}/invitations`, OrgInvitationListSchema, { signal }),
  });
  // Developer access is offered when the plan has seats and Polaris ID can enrol (the API says so).
  const developers = useQuery({
    queryKey: [...key, 'developers'],
    queryFn: ({ signal }) => api.get(`${path}/developers`, DeveloperListSchema, { signal }),
    enabled: !personal,
    retry: false,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const isCurrentPrincipal = (principalId: string) => {
    const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    return session?.authenticated === true && session.user.id === principalId;
  };
  // A response that lands after the person signed out or switched account is dropped.
  const invite = useMutation({
    mutationFn: async ({ body, principalId }: { body: InviteBody; principalId: string }) => {
      if (!isCurrentPrincipal(principalId)) return undefined;
      try {
        if (body.developer)
          await api.post(`${path}/developer-invitations`, DeveloperInvitationSchema, {
            email: body.email,
            ...(body.roles.length ? { roles: body.roles } : {}),
          });
        else await api.post(`${path}/invitations`, OrgInvitationSchema, body);
        if (isCurrentPrincipal(principalId)) return true;
      } catch (error) {
        if (isCurrentPrincipal(principalId)) throw error;
      }
      return undefined;
    },
    onSettled: (sent, error, { principalId }) => {
      if ((sent || error) && isCurrentPrincipal(principalId)) return refresh();
      return undefined;
    },
  });
  const revoke = useMutation({
    mutationFn: ({ kind, id }: { kind: 'memberships' | 'invitations'; id: string }) =>
      api.delete(`${path}/${kind}/${encodeURIComponent(id)}`),
    onSettled: async () => {
      await Promise.all([
        refresh(),
        client.resetQueries({ queryKey: membershipsQuery.queryKey, exact: true }),
      ]);
    },
  });
  const sendInvite: SendInvite = async (body) => {
    const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!session?.authenticated || session.user.id !== authed?.user.id) return false;
    const principalId = session.user.id;
    const sent = await invite.mutateAsync({ body, principalId });
    return Boolean(sent) && isCurrentPrincipal(principalId);
  };
  const resend = useMutation({
    mutationFn: (id: string) =>
      api.post(`${path}/invitations/${encodeURIComponent(id)}/resend`, OrgInvitationSchema),
    onSettled: () => refresh(),
  });
  const changeRoles = useMutation({
    mutationFn: ({ id, roles }: { id: string; roles: OrgRole[] }) =>
      api.patch(`${path}/memberships/${encodeURIComponent(id)}`, OrgMemberSchema, { roles }),
    // The member's membership id changes with their roles: the signed-in person's own list is read again.
    onSettled: () =>
      Promise.all([
        refresh(),
        client.resetQueries({ queryKey: membershipsQuery.queryKey, exact: true }),
      ]),
  });
  return {
    members,
    invitations,
    sendInvite,
    resend,
    revoke,
    changeRoles,
    inviting: invite.isPending,
    developersAvailable: developers.data?.available === true,
  };
}
