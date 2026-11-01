import type { ColumnDef } from '@tanstack/react-table';
import { ChevronDown, Copy, KeyRound, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ACTION_ICON } from '@/web/lib/action-icons.ts';
import { cn } from '@/web/lib/cn.ts';
import { formatDay } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  EntityChip,
  ErrorState,
  LoadMore,
  PageHeader,
  RowActions,
  StatusPill,
  toast,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import './api-keys.css';
import { CreateKeyDialog } from './create-key-dialog.tsx';
import { type ApiKey, keyState, SCOPE_LABEL, useApiKeys, useRevokeKey } from './queries.ts';

export { keyState } from './queries.ts';

const STATE_TONE = { active: 'success', expired: 'warning', revoked: 'neutral' } as const;

export function ApiKeysPage() {
  const orgName = useOrgNames();
  const { orgId } = useOrgScope();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey>();
  const [showRevoked, setShowRevoked] = useState(false);
  // Revoked here: the row stays in place, dimmed, until the page is left.
  const [justRevoked, setJustRevoked] = useState<ReadonlySet<string>>(new Set());
  const list = useApiKeys();
  const revoke = useRevokeKey();
  const now = Date.now();

  const all = (list.data?.items ?? []).filter((k) => !orgId || k.orgId === orgId);
  const live = all.filter((k) => k.revokedAt === null || justRevoked.has(k.id));
  const revoked = all.filter((k) => k.revokedAt !== null && !justRevoked.has(k.id));
  const rows = showRevoked ? [...live, ...revoked] : live;
  const empty = !list.isPending && !list.isError && all.length === 0;

  const columns = useMemo<ColumnDef<ApiKey, never>[]>(
    () => [
      {
        header: 'Name',
        id: 'name',
        cell: ({ row }) => {
          const k = row.original;
          const gone = k.revokedAt !== null;
          return (
            <div className="flex min-h-10 min-w-0 items-center gap-3">
              <span
                aria-hidden
                data-revoked={gone ? '' : undefined}
                data-verb-done={justRevoked.has(k.id) ? 'undo' : undefined}
                className="inline-flex shrink-0 text-fg-muted [&>svg]:size-4"
              >
                <KeyRound />
              </span>
              <div className="min-w-0">
                <span className="block truncate font-medium text-fg-strong">{k.name}</span>
                <code className="block truncate font-mono text-xs text-fg-muted">
                  wlt_{k.prefix}
                </code>
              </div>
            </div>
          );
        },
      },
      {
        header: 'Organization',
        id: 'org',
        meta: { nowrap: true, hideBelow: 'lg' },
        cell: ({ row }) => orgName(row.original.orgId),
      },
      {
        header: 'Scopes',
        id: 'scopes',
        meta: { hideBelow: 'xl', stackHidden: true },
        cell: ({ row }) => (
          <span
            className="block max-w-64 truncate text-fg"
            title={row.original.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}
          >
            {row.original.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}
          </span>
        ),
      },
      {
        header: 'Created',
        id: 'created',
        meta: { nowrap: true, stackHidden: true, hideBelow: 'md' },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span>{formatDay(row.original.createdAt)}</span>
            {row.original.createdBy ? (
              <EntityChip
                kind="user"
                id={row.original.createdBy}
                name={row.original.createdByName}
                to={`/admin/users/${row.original.createdBy}`}
                className="text-xs"
              />
            ) : null}
          </span>
        ),
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
          const s = keyState(row.original, now);
          return <StatusPill status={s} tone={STATE_TONE[s]} />;
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
                  onSelect: () =>
                    void navigator.clipboard
                      .writeText(`wlt_${row.original.prefix}`)
                      .then(() => toast.success('Prefix copied'), toast.error),
                },
                ...(row.original.revokedAt === null
                  ? [
                      {
                        label: 'Revoke',
                        icon: ACTION_ICON.void,
                        destructive: true,
                        onSelect: () => setRevoking(row.original),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        ),
      },
    ],
    [orgName, justRevoked, now],
  );

  const create = (variant: 'primary' | 'outline') => (
    <Button variant={variant} iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
      New API key
    </Button>
  );

  return (
    <>
      <PageHeader title="API keys" actions={create(empty ? 'outline' : 'primary')} />
      {list.isError && all.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="wl-keys">
          <DataTable
            caption="API keys"
            loading={list.isPending}
            fetching={list.isFetching}
            data={rows}
            getRowId={(k) => k.id}
            empty={<EmptyState art="key" title="No API keys" action={create('primary')} />}
            footer={
              <div className="flex flex-wrap items-center justify-between gap-3">
                <LoadMore
                  hasMore={false}
                  onLoadMore={() => undefined}
                  shown={live.length}
                  noun={['API key', 'API keys']}
                  scoped
                />
                {revoked.length ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3"
                    aria-expanded={showRevoked}
                    iconEnd={
                      <ChevronDown
                        aria-hidden
                        className={cn('transition-transform', showRevoked && 'rotate-180')}
                      />
                    }
                    onClick={() => setShowRevoked((s) => !s)}
                  >
                    {showRevoked ? 'Hide revoked' : `Show revoked (${revoked.length})`}
                  </Button>
                ) : null}
              </div>
            }
            columns={columns}
          />
        </div>
      )}
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        title={`Revoke ${revoking?.name ?? 'key'}?`}
        description="Requests using this key fail at once. This cannot be undone."
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          const id = revoking.id;
          await revoke.mutateAsync(id);
          setJustRevoked((s) => new Set(s).add(id));
          toast.success('Key revoked');
        }}
      />
    </>
  );
}
