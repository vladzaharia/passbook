import { MoreHorizontal, Trash2, UserCog } from 'lucide-react';
import type { ReactNode } from 'react';
import type { OrgMember } from '@/shared/contracts/org-membership.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Badge,
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EntityAvatar,
  IconButton,
  type RowAction,
  RowActions,
} from '@/web/ui/index.ts';
import { NO_EMAIL_LABEL } from '../../../shared/email.ts';
import { ROLE_LABELS } from './org-roles.ts';

const SHOWN_ROLES = 2;

export const memberName = (member: OrgMember) =>
  member.userName ?? member.userEmail ?? NO_EMAIL_LABEL;

/** The first two roles as badges, the rest behind "+N". */
export function RoleBadges({ roles }: { roles: OrgMember['roles'] }) {
  const rest = roles.slice(SHOWN_ROLES);
  return (
    <span className="flex w-max max-w-full flex-wrap items-center gap-1">
      {roles.slice(0, SHOWN_ROLES).map((role) => (
        <Badge key={role}>{ROLE_LABELS[role]}</Badge>
      ))}
      {rest.length > 0 ? (
        <Badge
          title={rest.map((role) => ROLE_LABELS[role]).join(', ')}
          aria-label={`${rest.length} more: ${rest.map((role) => ROLE_LABELS[role]).join(', ')}`}
        >
          +{rest.length}
        </Badge>
      ) : null}
    </span>
  );
}

/** One destructive action is the kit's trash button; anything else is a menu, so every row has the same control. */
function MemberActions({ actions, label }: { actions: readonly RowAction[]; label: string }) {
  const [only] = actions;
  if (!only) return null;
  if (actions.length === 1 && only.destructive)
    return <RowActions label={label} actions={actions} />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} size="sm" icon={<MoreHorizontal aria-hidden />} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            destructive={action.destructive}
            onSelect={action.onSelect}
          >
            <action.icon aria-hidden />
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface MemberTableProps {
  members: readonly OrgMember[];
  selfId: string | undefined;
  /** A personal org: one owner, nothing to change. */
  readOnly: boolean;
  onRemove: (member: OrgMember) => void;
  /** Absent until the API can change roles. */
  onChangeRoles?: ((member: OrgMember) => void) | undefined;
  loading?: boolean;
  error?: ReactNode;
}

export function MemberTable({
  members,
  selfId,
  readOnly,
  onRemove,
  onChangeRoles,
  loading,
  error,
}: MemberTableProps) {
  const admins = members.filter((m) => m.roles.includes('org_admin')).length;
  const columns: DataColumnDef<OrgMember, never>[] = [
    {
      id: 'member',
      header: 'Member',
      meta: { grow: true },
      cell: ({ row }) => {
        const member = row.original;
        const name = memberName(member);
        return (
          <div className="flex min-h-10 min-w-0 items-center gap-3">
            <EntityAvatar kind="user" id={member.userId} name={name} size={40} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-fg-strong">{name}</span>
                {member.userId === selfId ? <Badge tone="accent">You</Badge> : null}
              </div>
              {member.userName && member.userEmail ? (
                <span className="block truncate text-xs text-fg-muted">{member.userEmail}</span>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      id: 'roles',
      header: 'Roles',
      meta: { stackNoLabel: true },
      cell: ({ row }) => <RoleBadges roles={row.original.roles} />,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const member = row.original;
        const name = memberName(member);
        const self = member.userId === selfId;
        const lastAdmin = member.roles.includes('org_admin') && admins <= 1;
        const actions = readOnly
          ? []
          : [
              ...(onChangeRoles
                ? [
                    {
                      label: 'Change roles',
                      icon: UserCog,
                      onSelect: () => onChangeRoles(member),
                    },
                  ]
                : []),
              ...(self || lastAdmin
                ? []
                : [
                    {
                      label: onChangeRoles ? 'Remove' : `Remove ${name}`,
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => onRemove(member),
                    },
                  ]),
            ];
        return (
          <div className="flex justify-end">
            <MemberActions label={`Actions for ${name}`} actions={actions} />
          </div>
        );
      },
    },
  ];
  return (
    <DataTable
      caption="Members"
      columns={columns}
      data={members}
      getRowId={(member) => member.id}
      loading={loading ?? false}
      error={error}
    />
  );
}
