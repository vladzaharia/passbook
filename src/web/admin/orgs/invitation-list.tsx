import { Mail, Send, Trash2 } from 'lucide-react';
import type { OrgInvitation } from '@/shared/contracts/org-membership.ts';
import { formatAgo, formatDateTime } from '@/web/lib/format.ts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ListRow,
  ListRows,
  RowActions,
  useNow,
} from '@/web/ui/index.ts';
import { ROLE_LABELS } from './org-roles.ts';

/** Invitations not yet accepted or revoked. An accepted one is a member now, in the table. */
export const pendingInvitations = (items: readonly OrgInvitation[]) =>
  items.filter((i) => i.acceptedAt === null && i.revokedAt === null);

/** Pending invitations; renders nothing when there are none. */
export function InvitationList({
  invitations,
  onResend,
  onRevoke,
}: {
  invitations: readonly OrgInvitation[];
  onResend: (invitation: OrgInvitation) => void;
  onRevoke: (invitation: OrgInvitation) => void;
}) {
  const now = useNow();
  if (invitations.length === 0) return null;
  return (
    <Card>
      <CardHeader title={`Invitations (${invitations.length})`} />
      <CardBody>
        <ListRows label="Invitations">
          {invitations.map((invitation) => {
            const expired = invitation.expiresAt <= now;
            const roles = invitation.roles.map((role) => ROLE_LABELS[role]).join(', ');
            return (
              <ListRow
                key={invitation.id}
                rowId={invitation.id}
                leading={<Mail aria-hidden />}
                title={invitation.email}
                pills={expired ? <Badge tone="warning">Expired</Badge> : null}
                meta={`${roles} · Sent ${formatAgo(invitation.createdAt, now)} · ${
                  expired ? 'Expired' : 'Expires'
                } ${formatDateTime(invitation.expiresAt)}`}
                trailing={
                  <RowActions
                    label={`Actions for ${invitation.email}`}
                    actions={[
                      {
                        label: 'Resend',
                        icon: Send,
                        onSelect: () => onResend(invitation),
                      },
                      {
                        label: 'Revoke',
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => onRevoke(invitation),
                      },
                    ]}
                  />
                }
              />
            );
          })}
        </ListRows>
      </CardBody>
    </Card>
  );
}
