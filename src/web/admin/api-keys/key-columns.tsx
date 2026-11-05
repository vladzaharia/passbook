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
  /** Some listed key is not active: show the Status column. */
  withStatus: boolean;
  onRevoke: (key: ApiKey) => void;
}

/** What the list shows of a key: `wlt_` and the prefix, the start of every secret it issues. */
export const keyPrefix = (k: Pick<ApiKey, 'prefix'>) => `wlt_${k.prefix}`;

/** Name (no detail page: plain strong text), mode, org, scopes, created by, last used, status, actions. */

export function keyColumns({
  orgName,
  justRevoked,
  now,
  withStatus,
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
      meta: { nowrap: true, hideBelow: 'lg' },
      // A key with no org works across all of them.
      cell: ({ row }) =>
        row.original.orgId === null ? 'All organizations' : orgName(row.original.orgId),
    },
    {
      header: 'Scopes',
      id: 'scopes',
      meta: { hideBelow: 'xl', stackHidden: true },
      cell: ({ row }) => {
        const scopes = row.original.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ');
        return (
          <span className="block max-w-64 truncate text-fg" title={scopes}>
            {scopes}
          </span>
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
      header: 'Last used',
      id: 'used',
      meta: { hideBelow: 'xl', stackHidden: true, nowrap: true },
      cell: ({ row }) => formatDay(row.original.lastUsedAt, 'Never'),
    },
    // Active is what every row says: the column shows only when another state is listed.
    ...(withStatus
      ? [
          {
            header: 'Status',
            id: 'status',
            cell: ({ row }: { row: { original: ApiKey } }) => {
              const s = keyState(row.original, now);
              return s === 'active' ? null : <StatusPill status={s} tone={STATE_TONE[s]} />;
            },
          } satisfies ColumnDef<ApiKey, never>,
        ]
      : []),
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
              ...(row.original.revokedAt === null
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
