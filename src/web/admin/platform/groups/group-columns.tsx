import { Cloud, MoreHorizontal, Pencil, Tag, Trash2 } from 'lucide-react';
import type { Group } from '@/shared/contracts/idp-access.ts';
import { formatCount } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  RowLink,
} from '@/web/ui/index.ts';
import {
  deleteBlock,
  flagText,
  GroupKindPill,
  groupLabel,
  needsCreate,
  setBy,
} from './group-ui.tsx';

export interface GroupColumnsOptions {
  onRename: (group: Group) => void;
  onDelete: (group: Group) => void;
  onCreate: (group: Group) => void;
  onClaims: (group: Group) => void;
  creating: string | undefined;
}

/** Group, kind, members, where they come from, other apps, actions. */
export function groupColumns({
  onRename,
  onDelete,
  onCreate,
  onClaims,
  creating,
}: GroupColumnsOptions): DataColumnDef<Group, never>[] {
  return [
    {
      header: 'Group',
      id: 'group',
      cell: ({ row }) => {
        const g = row.original;
        return (
          <div className="min-w-0">
            <RowLink to="/admin/platform/groups/$key" params={{ key: g.key }}>
              {groupLabel(g)}
            </RowLink>
            <code className="block truncate font-mono text-xs text-fg-muted">{g.name}</code>
            {g.flags.map((flag) => (
              <span key={flag} className="block text-xs text-warning">
                {flagText(flag)}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      header: 'Kind',
      id: 'kind',
      cell: ({ row }) => <GroupKindPill kind={row.original.kind} />,
    },
    {
      header: 'Members',
      id: 'members',
      meta: { numeric: true },
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.members === null ? '—' : formatCount(row.original.members)}
        </span>
      ),
    },
    {
      header: 'Set by',
      id: 'source',
      meta: { hideBelow: 'lg' },
      cell: ({ row }) => <span className="text-fg-muted">{setBy(row.original)}</span>,
    },
    {
      header: 'Other apps',
      id: 'apps',
      meta: { numeric: true, hideBelow: 'xl' },
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.otherClients === null ? '—' : formatCount(row.original.otherClients)}
        </span>
      ),
    },
    {
      header: () => <span className="sr-only">Actions</span>,
      id: 'actions',
      cell: ({ row }) => {
        const g = row.original;
        if (needsCreate(g))
          return (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                aria-label="Create in Polaris ID"
                loading={creating === g.key}
                iconStart={<Cloud aria-hidden />}
                onClick={() => onCreate(g)}
              >
                Create<span className="max-sm:hidden"> in Polaris ID</span>
              </Button>
            </div>
          );
        const block = deleteBlock(g);
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label={`Actions for ${groupLabel(g)}`}
                  size="sm"
                  icon={<MoreHorizontal aria-hidden />}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onRename(g)}>
                  <Pencil aria-hidden />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onClaims(g)}>
                  <Tag aria-hidden />
                  Claims
                </DropdownMenuItem>
                {block === 'hidden' ? null : (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      destructive
                      disabled={block !== null}
                      onSelect={() => onDelete(g)}
                    >
                      <Trash2 aria-hidden />
                      Delete
                    </DropdownMenuItem>
                    {block ? <p className="px-2 pb-1.5 text-xs text-fg-muted">{block}</p> : null}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];
}
