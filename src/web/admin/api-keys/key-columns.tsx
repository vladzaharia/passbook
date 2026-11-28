import { Copy, KeyRound } from 'lucide-react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { copyText } from '@/web/lib/clipboard.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { entityLabel } from '@/web/lib/entity-label.ts';
import { formatDay } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { MetaLink, RowActions, StatusPill } from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { ROLE_LABELS } from '../orgs/org-roles.ts';
import { keyReach } from './key-kind-fields.ts';
import { KeyNameLink } from './key-name-link.tsx';
import { type ApiKey, keyState, SCOPE_LABEL } from './queries.ts';

export const STATE_TONE = {
  active: 'success',
  retiring: 'warning',
  retired: 'neutral',
  expired: 'warning',
  revoked: 'neutral',
} as const;

export interface KeyColumnsOptions {
  /** The organization of the list, or null for the platform's. */
  orgId: string | null;
  /** Revoked on this page: the glyph plays its undo turn. */
  justRevoked: ReadonlySet<string>;
  now: number;
  canRevoke: boolean;
  onRevoke: (key: ApiKey) => void;
  /** The creator's name links to their admin page; a host without one shows the name. */
  creatorLink?: boolean;
  /** The key the host runs on: labelled, with no Revoke. */
  isOwn?: (key: ApiKey) => boolean;
}

/** What the list shows of a key: the start of its secret (`pb_live_`, `pbp_`, `pbo_`, or `wlt_` for an older key) and its prefix. */
export const keyPrefix = (k: Pick<ApiKey, 'prefix' | 'secretPrefix'>) =>
  k.secretPrefix ?? `wlt_${k.prefix}`;

/** Name (links to the key's page), mode, scopes, created by, last used, status, actions. */

export function keyColumns({
  orgId,
  justRevoked,
  now,
  canRevoke,
  onRevoke,
  creatorLink = true,
  isOwn,
}: KeyColumnsOptions): DataColumnDef<ApiKey, never>[] {
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
              <span className="flex min-w-0 items-baseline gap-2">
                <KeyNameLink orgId={orgId} id={k.id}>
                  {k.name}
                </KeyNameLink>
                {(k.kind === 'service' || k.kind === 'platform') && !k.parentKeyId ? null : (
                  <span className="shrink-0 text-xs font-normal text-fg-muted">
                    {isOwn?.(k) ? 'Sandbox key' : k.parentKeyId ? 'Child' : 'Personal'}
                  </span>
                )}
                {k.origin === 'cli' ? (
                  <span className="shrink-0 text-xs font-normal text-fg-muted">CLI</span>
                ) : null}
              </span>
              <code className="block truncate font-mono text-xs text-fg-muted">{keyPrefix(k)}</code>
              {k.kind === 'platform' &&
              k.revokedAt === null &&
              (k.expiresAt === null || k.ipAllow.length === 0) ? (
                <span className="block text-xs text-warning">
                  Set allowed IPs and expiry: make a new key
                </span>
              ) : null}
            </div>
          </div>
        );
      },
    },
    ...(orgId === null
      ? [
          {
            header: 'Access',
            id: 'access',
            meta: { nowrap: true },
            cell: ({ row }: { row: { original: ApiKey } }) => keyReach(row.original),
          } satisfies DataColumnDef<ApiKey, never>,
        ]
      : []),
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
      header: 'Scopes',
      id: 'scopes',
      cell: ({ row }) => {
        const { roles, scopes: held } = row.original;
        const scopes = [
          ...roles.map((r) => ROLE_LABELS[r]),
          ...held.map((s) => SCOPE_LABEL[s] ?? s),
        ].join(', ');
        return (
          <span className="block max-w-72 whitespace-normal break-words text-fg">{scopes}</span>
        );
      },
    },
    {
      header: 'Created',
      id: 'created',
      meta: { nowrap: true, stackHidden: true, hideBelow: 'lg' },
      cell: ({ row }) => {
        const { createdAt, createdBy, createdByName } = row.original;
        return (
          <span className="flex min-w-0 flex-col items-start">
            <span>{formatDay(createdAt)}</span>
            {createdBy && !creatorLink ? (
              <span className="max-w-full truncate text-xs text-fg-muted">
                {entityLabel(createdByName, 'User')}
              </span>
            ) : createdBy ? (
              <MetaLink
                to="/admin/users/$userId"
                params={{ userId: createdBy }}
                icon={ENTITY.user.icon}
                className="min-h-0 max-w-full text-xs [&_svg]:size-3.5"
              >
                <span className="truncate">{entityLabel(createdByName, 'User')}</span>
              </MetaLink>
            ) : null}
          </span>
        );
      },
    },
    {
      header: 'Expiry',
      id: 'expiry',
      meta: { nowrap: true, hideBelow: 'xl' },
      cell: ({ row }) => formatDay(row.original.expiresAt, 'No expiry'),
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
              ...(canRevoke && row.original.revokedAt === null && !isOwn?.(row.original)
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
