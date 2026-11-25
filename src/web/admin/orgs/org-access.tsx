import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  DeveloperInvitationSchema,
  DeveloperListSchema,
} from '@/shared/contracts/developer-invitations.ts';
import {
  OrgInvitationListSchema,
  OrgInvitationSchema,
  OrgMemberListSchema,
  type OrgRole,
} from '@/shared/contracts/org-membership.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api } from '@/web/lib/api.ts';
import { revokeAccessConfirm } from '@/web/lib/confirms.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { membershipsQuery, sessionQuery, useSession } from '@/web/lib/session.ts';
import {
  Badge,
  Card,
  CardBody,
  ConfirmDialog,
  ErrorState,
  ListRow,
  ListRows,
  RowActions,
} from '@/web/ui/index.ts';
import { NO_EMAIL_LABEL } from '../../../shared/email.ts';
import { InviteForm, type SendInvite } from './org-invite-form.tsx';
import { ROLE_LABELS } from './org-roles.ts';

interface Revoking {
  kind: 'memberships' | 'invitations';
  id: string;
  label: string;
}

export function AccessCard({ org }: { org: { id: string; name: string; personal?: boolean } }) {
  const path = `/api/v1/orgs/${encodeURIComponent(org.id)}`;
  const key = ['org-access', org.id];
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
    enabled: !org.personal,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const isCurrentPrincipal = (principalId: string) => {
    const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    return session?.authenticated === true && session.user.id === principalId;
  };
  const invite = useMutation({
    mutationFn: async ({
      body,
      principalId,
    }: {
      body: { email: string; roles: OrgRole[]; developer?: boolean };
      principalId: string;
    }) => {
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
  const [revoking, setRevoking] = useState<Revoking | null>(null);
  // An accepted invitation is a member now, in the list above: it is not listed twice.
  const open = invitations.data?.items.filter((i) => i.acceptedAt === null) ?? [];

  const sendInvite: SendInvite = async (body) => {
    const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!session?.authenticated || session.user.id !== authed?.user.id) return false;
    const principalId = session.user.id;
    const sent = await invite.mutateAsync({ body, principalId });
    return Boolean(sent) && isCurrentPrincipal(principalId);
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-5">
        <section aria-labelledby="org-members-heading" className="flex flex-col gap-3">
          {/* The page's h1 says Members: the heading stays for assistive tech and names the list. */}
          <h2 id="org-members-heading" className="sr-only">
            Members
          </h2>
          {members.isPending ? (
            <p role="status" className="text-sm text-fg-muted">
              Loading members…
            </p>
          ) : members.isError ? (
            <ErrorState subject="members" error={members.error} onRetry={() => members.refetch()} />
          ) : members.data.items.filter((member) => member.revokedAt === null).length === 0 ? (
            <p className="text-sm text-fg-muted">No active members.</p>
          ) : (
            <ListRows label="Members">
              {members.data.items
                .filter((member) => member.revokedAt === null)
                .map((member) => {
                  const label = member.userName ?? member.userEmail ?? NO_EMAIL_LABEL;
                  const self = member.userId === authed?.user.id;
                  const roles = member.roles.map((role) => ROLE_LABELS[role]).join(', ');
                  return (
                    <ListRow
                      key={member.id}
                      title={label}
                      pills={self ? <Badge>You</Badge> : null}
                      meta={
                        member.userName && member.userEmail
                          ? `${member.userEmail} · ${roles}`
                          : roles
                      }
                      trailing={
                        org.personal || self ? null : (
                          <RowActions
                            label={`Actions for ${label}`}
                            actions={[
                              {
                                label: `Revoke membership for ${label}`,
                                icon: Trash2,
                                destructive: true,
                                onSelect: () =>
                                  setRevoking({ kind: 'memberships', id: member.id, label }),
                              },
                            ]}
                          />
                        )
                      }
                    />
                  );
                })}
            </ListRows>
          )}
        </section>
        <section aria-labelledby="org-invitations-heading" className="flex flex-col gap-3">
          <h2 id="org-invitations-heading" className="text-sm font-semibold text-fg-strong">
            Invitations
          </h2>
          {invitations.isPending ? (
            <p role="status" className="text-sm text-fg-muted">
              Loading invitations…
            </p>
          ) : invitations.isError ? (
            <ErrorState
              subject="invitations"
              error={invitations.error}
              onRetry={() => invitations.refetch()}
            />
          ) : open.length === 0 ? (
            <p className="text-sm text-fg-muted">No invitations.</p>
          ) : (
            <ListRows label="Invitations">
              {open.map((invitation) => {
                const status =
                  invitation.revokedAt !== null
                    ? 'Revoked'
                    : invitation.expiresAt <= Date.now()
                      ? 'Expired'
                      : 'Pending';
                const roles = invitation.roles.map((role) => ROLE_LABELS[role]).join(', ');
                return (
                  <ListRow
                    key={invitation.id}
                    title={invitation.email}
                    meta={`${roles} · ${status} · Expires ${formatDateTime(invitation.expiresAt)}`}
                    trailing={
                      status === 'Pending' ? (
                        <RowActions
                          label={`Actions for ${invitation.email}`}
                          actions={[
                            {
                              label: `Revoke invitation for ${invitation.email}`,
                              icon: Trash2,
                              destructive: true,
                              onSelect: () =>
                                setRevoking({
                                  kind: 'invitations',
                                  id: invitation.id,
                                  label: invitation.email,
                                }),
                            },
                          ]}
                        />
                      ) : null
                    }
                  />
                );
              })}
            </ListRows>
          )}
          {org.personal ? null : (
            <InviteForm
              pending={invite.isPending}
              onInvite={sendInvite}
              developers={developers.data?.available === true}
            />
          )}
        </section>
        <ConfirmDialog
          open={revoking !== null}
          onOpenChange={(open) => !open && setRevoking(null)}
          {...revokeAccessConfirm(revoking?.kind ?? 'memberships', revoking?.label ?? '', {
            self: false,
            org: org.name,
          })}
          destructive
          onConfirm={async () => {
            if (revoking) await revoke.mutateAsync({ kind: revoking.kind, id: revoking.id });
          }}
        />
      </CardBody>
    </Card>
  );
}
