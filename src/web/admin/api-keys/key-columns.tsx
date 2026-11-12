import type { ColumnDef } from '@tanstack/react-table';
import { Copy, KeyRound } from 'lucide-react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { copyText } from '@/web/lib/clipboard.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { formatDay } from '@/web/lib/format.ts';
import { MetaLink, RowActions, StatusPill } from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { type ApiKey, keyState, SCOPE_LABEL } from './queries.ts';

const STATE_TONE = { active: 'success', expired: 'warning', revoked: 'neutral' } as const;

export interface KeyColumnsOptions {
  orgName: (id: string | null) => string;
  /** Revoked on this page: the glyph plays its undo turn. */
  justRevoked: ReadonlySet<string>;
  now: number;
  canRevoke: boolean;
  onRevoke: (key: ApiKey) => void;
}

/** What the list shows of a key: `wlt_` and the prefix, the start of every secret it issues. */
export const keyPrefix = (k: Pick<ApiKey, 'prefix'>) => `wlt_${k.prefix}`;

/** Name (no detail page: plain strong text), mode, org, scopes, created by, last used, status, actions. */

export function keyColumns({
  orgName,
  justRevoked,
  now,
  canRevoke,
  onRevoke,
}: KeyColumnsOptions): ColumnDef<ApiKey, never>[] {
  return [
    {
      header: 'Name',
      id: 'name',
      cell: ({ row }) => {
        const k = row.original;
        return (
          <div className="flex min-h-10 min-w-0 items-center gap-3">
            <span
              aria-hidden
              data-revoked={k.revokedAt !== null ? '' : undefined}
              data-verb-done={justRevoked.has(k.id) ? 'undo' : undefined}
              className="inline-flex shrink-0 text-fg-muted [&>svg]:size-4"
            >
              <KeyRound />
            </span>
            <div className="min-w-0">
              <span className="block truncate font-medium text-fg-strong">{k.name}</span>
              <code className="block truncate font-mono text-xs text-fg-muted">{keyPrefix(k)}</code>
            </div>
          </div>
        );
      },
    },
    {
      header: 'Mode',
      id: 'mode',
      meta: { nowrap: true },
      cell: ({ row }) =>
        row.original.mode === 'test' ? (
          <ModePill mode="test" />
        ) : (
          <span className="text-fg-muted">Live</span>
        ),
    },
    {
      header: 'Organization',
      id: 'org',
      meta: { nowrap: true },
      cell: ({ row }) => orgName(row.original.orgId),
    },
    {
      header: 'Scopes',
      id: 'scopes',
      cell: ({ row }) => {
        const scopes = row.original.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ');
        return (
          <span className="block max-w-64 whitespace-normal break-words text-fg">{scopes}</span>
        );
      },
    },
    {
      header: 'Created',
      id: 'created',
      meta: { nowrap: true, stackHidden: true, hideBelow: 'md' },
      cell: ({ row }) => {
        const { createdAt, createdBy, createdByName } = row.original;
        return (
          <span className="flex min-w-0 flex-col items-start">
            <span>{formatDay(createdAt)}</span>
            {createdBy ? (
              <MetaLink
                to="/admin/users/$userId"
                params={{ userId: createdBy }}
                icon={ENTITY.user.icon}
                className="min-h-0 max-w-full text-xs [&_svg]:size-3.5"
              >
                <span className="truncate">{createdByName ?? `User ${createdBy.slice(-6)}`}</span>
              </MetaLink>
            ) : null}
          </span>
        );
      },
    },
    {
      header: 'Expiry',
      id: 'expiry',
      meta: { nowrap: true },
      cell: ({ row }) => formatDay(row.original.expiresAt, 'Never'),
    },
    {
      header: 'Last used',
      id: 'used',
      meta: { hideBelow: 'xl', stackHidden: true, nowrap: true },
      cell: ({ row }) => formatDay(row.original.lastUsedAt, 'Never'),
    },
    {
      header: 'Status',
      id: 'status',
      cell: ({ row }) => {
        const state = keyState(row.original, now);
        return <StatusPill status={state} tone={STATE_TONE[state]} />;
      },
    },
    {
      header: () => <span className="sr-only">Actions</span>,
      id: 'actions',
      cell: ({ row }) => (
        <div className="flex justify-end">
          <RowActions
            label={`Actions for ${row.original.name}`}
            actions={[
              {
                label: 'Copy prefix',
                icon: Copy,
                onSelect: () => void copyText(keyPrefix(row.original), 'prefix'),
              },
              ...(canRevoke && row.original.revokedAt === null
                ? [
                    {
                      label: 'Revoke',
                      icon: ACTION_ICON.void,
                      destructive: true,
                      onSelect: () => onRevoke(row.original),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      ),
    },
  ];
}
