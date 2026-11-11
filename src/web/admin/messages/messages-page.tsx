import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useMemo } from 'react';
import type { BroadcastDto, BroadcastState } from '@/shared/contracts/broadcasts.ts';
import { ENTITY } from '../../lib/entities.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FilteredEmpty,
  LoadMore,
  PageHeader,
  RowLink,
  SkeletonRows,
  StatusPill,
} from '../../ui/index.ts';
import { ForbiddenPage } from '../../ui/layout/error-pages.tsx';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import { useBroadcastPages } from './api.ts';
import { countsLine, KIND_LABEL, STATE_FILTERS, whenLine } from './labels.ts';
import { BroadcastProgress } from './progress.tsx';

const ALL = 'all';

export interface MessagesSearch {
  state?: BroadcastState | undefined;
}

export function MessagesPage({
  search,
  onSearch,
}: {
  search: MessagesSearch;
  onSearch: (patch: Partial<MessagesSearch>) => void;
}) {
  const scope = useOrgScope();
  if (scope.isLoading) return <SkeletonRows label="Loading organization access" />;
  if (scope.isError)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (!scope.orgId)
    return (
      <EmptyState
        heading
        art="building"
        title="Choose an organization"
        description="Choose an organization in the top bar to continue."
      />
    );
  if (!scope.membership?.capabilities.includes('messages:read')) return <ForbiddenPage />;
  return (
    <ScopedMessagesPage
      key={scope.orgId}
      orgId={scope.orgId}
      canCreate={scope.membership?.capabilities.includes('messages:manage') === true}
      search={search}
      onSearch={onSearch}
    />
  );
}

function ScopedMessagesPage({
  orgId,
  canCreate,
  search,
  onSearch,
}: {
  orgId: string;
  canCreate: boolean;
  search: MessagesSearch;
  onSearch: (patch: Partial<MessagesSearch>) => void;
}) {
  const list = useBroadcastPages({ orgId, state: search.state });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // Test mode already says so in the header; a pill on every row would repeat it.
  const mixed = rows.some((r) => r.mode !== 'test');
  const columns = useMemo<ColumnDef<BroadcastDto, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Message',
        cell: ({ row }) => (
          <div className="min-w-0 max-w-80">
            <span className="flex min-w-0 items-center gap-2">
              <RowLink to="/admin/messages/$broadcastId" params={{ broadcastId: row.original.id }}>
                {row.original.name}
              </RowLink>
              {mixed ? <ModePill mode={row.original.mode} compact /> : null}
            </span>
            <span className="block truncate text-xs text-fg-muted">
              {KIND_LABEL[row.original.kind]}
            </span>
            {/* Phones show one row per message: the columns that fit nowhere move under the name. */}
            <span className="mt-1 flex flex-col gap-1 text-xs text-fg-muted md:hidden">
              <span>{whenLine(row.original)}</span>
              {row.original.state === 'sending' ? (
                <BroadcastProgress broadcast={row.original} className="w-40" />
              ) : countsLine(row.original) ? (
                <span>{countsLine(row.original)}</span>
              ) : null}
            </span>
          </div>
        ),
      },
      {
        id: 'state',
        header: 'State',
        meta: { nowrap: true },
        cell: ({ row }) => (
          <StatusPill status={row.original.state}>
            {row.original.state === 'sent' ? 'Completed' : undefined}
          </StatusPill>
        ),
      },
      {
        id: 'progress',
        header: 'Progress',
        meta: { hideBelow: 'md', stackHidden: true },
        cell: ({ row }) => {
          const b = row.original;
          return b.state === 'sending' ? (
            <BroadcastProgress broadcast={b} className="w-40" />
          ) : (
            <span className="text-fg-muted">{countsLine(b) || '—'}</span>
          );
        },
      },
      {
        id: 'when',
        header: 'When',
        meta: { nowrap: true, hideBelow: 'md', stackHidden: true },
        cell: ({ row }) => whenLine(row.original),
      },
    ],
    [mixed],
  );

  const filtered = Boolean(search.state);
  const clear = () => onSearch({ state: undefined });
  const empty = !list.isPending && rows.length === 0 && !filtered;
  const create = (variant: 'primary' | 'outline') =>
    canCreate ? (
      <Button asChild variant={variant} iconStart={<Plus aria-hidden />}>
        <Link to="/admin/messages/new">New message</Link>
      </Button>
    ) : null;

  return (
    <>
      <PageHeader title="Messages" actions={create(empty ? 'outline' : 'primary')} />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Messages"
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          loading={list.isPending}
          fetching={list.isFetching && !list.isFetchingNextPage}
          filtered={filtered}
          toolbar={
            <FilterBar
              filters={[
                {
                  id: 'state',
                  label: 'State',
                  value: search.state ?? ALL,
                  defaultValue: ALL,
                  options: [
                    { value: ALL, label: 'All' },
                    ...STATE_FILTERS.map(([value, label]) => ({ value, label })),
                  ],
                  onChange: (v) =>
                    onSearch({ state: v === ALL ? undefined : (v as BroadcastState) }),
                },
              ]}
              onClear={clear}
            />
          }
          emptyFiltered={<FilteredEmpty entity="broadcast" onClear={clear} />}
          empty={
            <EmptyState art={ENTITY.broadcast.art} title="No messages" action={create('primary')} />
          }
          footer={
            <LoadMore
              query={list}
              shown={rows.length || undefined}
              noun={['message', 'messages']}
              scoped
            />
          }
        />
      )}
    </>
  );
}
