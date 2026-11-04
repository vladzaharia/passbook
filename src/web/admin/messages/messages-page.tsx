import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useMemo } from 'react';
import type { BroadcastDto, BroadcastState } from '@/shared/contracts/broadcasts.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
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
  StatusPill,
} from '../../ui/index.ts';
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
  const { orgId } = useOrgScope();
  const orgs = useOrgOptions();
  const list = useBroadcastPages({ orgId, state: search.state });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const orgNames = useMemo(
    () => new Map((orgs.data?.items ?? []).map((o) => [o.id, o.name])),
    [orgs.data],
  );
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
              <ModePill mode={row.original.mode} compact />
            </span>
            <span className="block truncate text-xs text-fg-muted">
              {KIND_LABEL[row.original.kind]}
              {orgId ? '' : ` · ${orgNames.get(row.original.orgId) ?? '—'}`}
            </span>
          </div>
        ),
      },
      {
        id: 'state',
        header: 'State',
        meta: { nowrap: true },
        cell: ({ row }) => <StatusPill status={row.original.state} />,
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
        meta: { nowrap: true, hideBelow: 'lg', stackHidden: true },
        cell: ({ row }) => whenLine(row.original),
      },
    ],
    [orgNames, orgId],
  );

  const filtered = Boolean(search.state);
  const clear = () => onSearch({ state: undefined });
  const empty = !list.isPending && rows.length === 0 && !filtered;
  const create = (variant: 'primary' | 'outline') => (
    <Button asChild variant={variant} iconStart={<Plus aria-hidden />}>
      <Link to="/admin/messages/new">New message</Link>
    </Button>
  );

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
          empty={<EmptyState art="envelope" title="No messages" action={create('primary')} />}
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
