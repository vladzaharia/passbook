import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
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
import { Button, Card, CardBody, CardHeader, ConfirmDialog, ErrorState } from '@/web/ui/index.ts';
import { InviteForm, type SendInvite } from './org-invite-form.tsx';
import { ROLE_LABELS } from './org-roles.ts';

interface Revoking {
  kind: 'memberships' | 'invitations';
  id: string;
  label: string;
  /** Your own membership: revoking it ends your access to this organization. */
  self: boolean;
}

export function AccessCard({ org }: { org: { id: string; name: string } }) {
  const path = `/api/v1/orgs/${encodeURIComponent(org.id)}`;
  const key = ['org-access', org.id];
  const client = useQueryClient();
  const { isAdmin, authed } = useSession();
  const members = useQuery({
    queryKey: [...key, 'memberships'],
    queryFn: ({ signal }) => api.get(`${path}/memberships`, OrgMemberListSchema, { signal }),
  });
  const invitations = useQuery({
    queryKey: [...key, 'invitations'],
    queryFn: ({ signal }) => api.get(`${path}/invitations`, OrgInvitationListSchema, { signal }),
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
      body: { email: string; roles: OrgRole[] };
      principalId: string;
    }) => {
      if (!isCurrentPrincipal(principalId)) return undefined;
      try {
        await api.post(`${path}/invitations`, OrgInvitationSchema, body);
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

  const sendInvite: SendInvite = async (body) => {
    const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!session?.authenticated || session.user.id !== authed?.user.id) return false;
    const principalId = session.user.id;
    const sent = await invite.mutateAsync({ body, principalId });
    return Boolean(sent) && isCurrentPrincipal(principalId);
  };

  return (
    <Card>
      <CardHeader title="People & service access" />
      <CardBody className="flex flex-col gap-5">
        <section aria-labelledby="org-members-heading" className="flex flex-col gap-3">
          <h3 id="org-members-heading" className="text-sm font-semibold text-fg-strong">
            Members
          </h3>
          {members.isPending ? (
            <p role="status" className="text-sm text-fg-muted">
              Loading members…
            </p>
          ) : members.isError ? (
            <ErrorState subject="members" error={members.error} onRetry={() => members.refetch()} />
          ) : members.data.items.filter((member) => member.revokedAt === null).length === 0 ? (
            <p className="text-sm text-fg-muted">No active members.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {members.data.items
                .filter((member) => member.revokedAt === null)
                .map((member) => {
                  const label = member.userName ?? member.userEmail;
                  const self = member.userId === authed?.user.id;
                  return (
                    <li
                      key={member.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                    >
                      <div className="min-w-0 text-sm">
                        <p className="break-words font-medium text-fg-strong">
                          {label}
                          {self ? <span className="ml-2 text-xs text-fg-muted">You</span> : null}
                        </p>
                        {member.userName ? (
                          <p className="break-all text-fg-muted">{member.userEmail}</p>
                        ) : null}
                        <p className="text-fg-muted">
                          {member.roles.map((role) => ROLE_LABELS[role]).join(', ')}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Revoke membership for ${label}`}
                        onClick={() =>
                          setRevoking({ kind: 'memberships', id: member.id, label, self })
                        }
                      >
                        Revoke
                      </Button>
                    </li>
                  );
                })}
            </ul>
          )}
        </section>
        <section aria-labelledby="org-invitations-heading" className="flex flex-col gap-3">
          <h3 id="org-invitations-heading" className="text-sm font-semibold text-fg-strong">
            Invitations
          </h3>
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
          ) : invitations.data.items.length === 0 ? (
            <p className="text-sm text-fg-muted">No invitations.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {invitations.data.items.map((invitation) => {
                const status =
                  invitation.revokedAt !== null
                    ? 'Revoked'
                    : invitation.acceptedAt !== null
                      ? 'Accepted'
                      : invitation.expiresAt <= Date.now()
                        ? 'Expired'
                        : 'Pending';
                return (
                  <li
                    key={invitation.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                  >
                    <div className="min-w-0 text-sm">
                      <p className="break-all font-medium text-fg-strong">{invitation.email}</p>
                      <p className="text-fg-muted">
                        {invitation.roles.map((role) => ROLE_LABELS[role]).join(', ')}
                      </p>
                      <p className="text-xs text-fg-muted">
                        {status} · Expires {formatDateTime(invitation.expiresAt)}
                      </p>
                    </div>
                    {status === 'Pending' && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Revoke invitation for ${invitation.email}`}
                        onClick={() =>
                          setRevoking({
                            kind: 'invitations',
                            id: invitation.id,
                            label: invitation.email,
                            self: false,
                          })
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <InviteForm pending={invite.isPending} onInvite={sendInvite} />
        </section>
        {isAdmin ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <div>
              <Button asChild variant="outline" size="sm" iconEnd={<ChevronRight aria-hidden />}>
                <Link to="/admin/api-keys" search={{ orgId: org.id, new: undefined }}>
                  Review API keys
                </Link>
              </Button>
            </div>
          </div>
        ) : null}
        <ConfirmDialog
          open={revoking !== null}
          onOpenChange={(open) => !open && setRevoking(null)}
          {...revokeAccessConfirm(revoking?.kind ?? 'memberships', revoking?.label ?? '', {
            self: revoking?.self ?? false,
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
