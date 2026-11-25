import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { OrgInvitation, OrgMember } from '@/shared/contracts/org-membership.ts';
import { removeMemberConfirm, revokeAccessConfirm } from '@/web/lib/confirms.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { useSession } from '@/web/lib/session.ts';
import { Button, ConfirmDialog, EmptyState, ErrorState, toast } from '@/web/ui/index.ts';
import { ChangeRolesDialog } from './change-roles-dialog.tsx';
import { InvitationList, pendingInvitations } from './invitation-list.tsx';
import { InviteDialog } from './invite-dialog.tsx';
import { MemberTable, memberName } from './member-table.tsx';
import { CAN_CHANGE_ROLES } from './org-roles.ts';
import { useOrgAccess } from './use-org-access.ts';

type Pending =
  | { kind: 'member'; member: OrgMember }
  | { kind: 'invitation'; invitation: OrgInvitation };

export interface MembersPanelProps {
  org: { id: string; name: string; personal?: boolean };
  inviteOpen: boolean;
  onInviteOpenChange: (open: boolean) => void;
}

/** The member table, pending invitations, and the dialogs that change them. */
export function MembersPanel({ org, inviteOpen, onInviteOpenChange }: MembersPanelProps) {
  const { authed } = useSession();
  const access = useOrgAccess(org.id);
  const { members, invitations } = access;
  const [removing, setRemoving] = useState<Pending | null>(null);
  const [editing, setEditing] = useState<OrgMember | null>(null);
  const active = members.data?.items.filter((member) => member.revokedAt === null) ?? [];
  const open = pendingInvitations(invitations.data?.items ?? []);
  const personal = org.personal === true;

  const resend = async (invitation: OrgInvitation) => {
    try {
      await access.resend(invitation);
      toast.sent(`Invitation sent to ${invitation.email}`);
    } catch (cause) {
      toast.error(cause, 'Could not resend');
    }
  };
  const confirm =
    removing?.kind === 'member'
      ? removeMemberConfirm(memberName(removing.member), org.name)
      : removing
        ? revokeAccessConfirm('invitations', removing.invitation.email, {
            self: false,
            org: org.name,
          })
        : null;

  return (
    <div className="flex flex-col gap-6">
      {members.isError ? (
        <ErrorState subject="members" error={members.error} onRetry={() => members.refetch()} />
      ) : (
        <MemberTable
          members={active}
          selfId={authed?.user.id}
          readOnly={personal}
          loading={members.isPending}
          onRemove={(member) => setRemoving({ kind: 'member', member })}
          onChangeRoles={CAN_CHANGE_ROLES ? setEditing : undefined}
        />
      )}
      {invitations.isError ? (
        <ErrorState
          subject="invitations"
          error={invitations.error}
          onRetry={() => invitations.refetch()}
        />
      ) : (
        <InvitationList
          invitations={open}
          onResend={(invitation) => void resend(invitation)}
          onRevoke={(invitation) => setRemoving({ kind: 'invitation', invitation })}
        />
      )}
      {!personal && members.isSuccess && active.length === 1 && open.length === 0 ? (
        <EmptyState
          art="people"
          title="Invite your team"
          action={
            <Button iconStart={<Plus aria-hidden />} onClick={() => onInviteOpenChange(true)}>
              Invite member
            </Button>
          }
        />
      ) : null}
      {personal ? null : (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={onInviteOpenChange}
          pending={access.inviting}
          onInvite={access.sendInvite}
        />
      )}
      <ChangeRolesDialog
        member={editing}
        name={editing ? memberName(editing) : ''}
        onClose={() => setEditing(null)}
        onSave={async (member, roles) => {
          try {
            await access.changeRoles.mutateAsync({ id: member.id, roles });
            toast.success('Roles saved');
            return true;
          } catch (cause) {
            toast.error(errorMessage(cause), 'Could not save roles');
            return false;
          }
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        {...(confirm ?? { title: '', confirmLabel: '', description: '', typed: false })}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await access.revoke.mutateAsync(
            removing.kind === 'member'
              ? { kind: 'memberships', id: removing.member.id }
              : { kind: 'invitations', id: removing.invitation.id },
          );
        }}
      />
    </div>
  );
}
