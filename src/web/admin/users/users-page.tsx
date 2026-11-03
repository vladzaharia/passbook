import type { ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import type { z } from 'zod';
import type { UserSummarySchema } from '@/shared/contracts/users.ts';
import { useDebouncedCommit } from '@/web/lib/debounce.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  CountLink,
  DataTable,
  EmptyState,
  EntityAvatar,
  ErrorState,
  FilterBar,
  FilteredEmpty,
  LoadMore,
  PageHeader,
  RowLink,
  StatusPill,
} from '@/web/ui/index.ts';
import { methodsLabel } from './labels.ts';
import { useUserList } from './queries.ts';
import type { UsersSearch } from './users-search.ts';

type UserRow = z.infer<typeof UserSummarySchema>;

const ALL = 'all';

const COLUMNS: ColumnDef<UserRow, never>[] = [
  {
    header: 'User',
    id: 'user',
    cell: ({ row }) => {
      const u = row.original;
      const name = u.name ?? u.primaryEmail;
      return (
        <div className="flex min-h-10 min-w-0 items-center gap-3">
          <EntityAvatar kind="user" id={u.id} name={name} />
          <div className="min-w-0">
            <RowLink to="/admin/users/$userId" params={{ userId: u.id }}>
              {name}
            </RowLink>
            {u.name ? (
              <span className="block truncate text-xs text-fg-muted">{u.primaryEmail}</span>
            ) : null}
          </div>
        </div>
      );
    },
  },
  {
    header: 'Status',
    id: 'status',
    cell: ({ row }) => <StatusPill status={row.original.status} />,
  },
  {
    header: 'Roles',
    id: 'roles',
    meta: { stackHidden: true },
    cell: ({ row }) =>
      row.original.lastRoles.length ? (
        <span className="flex flex-wrap gap-1">
          {row.original.lastRoles.map((r) => (
            <StatusPill key={r} status={r} />
          ))}
        </span>
      ) : (
        '—'
      ),
  },
  {
    header: 'Signs in with',
    id: 'methods',
    meta: { nowrap: true, hideBelow: 'lg' },
    cell: ({ row }) => methodsLabel(row.original.signInMethods),
  },
  {
    header: 'Passes',
    id: 'passes',
    meta: { numeric: true },
    cell: ({ row }) => (
      <CountLink
        count={row.original.passCount}
        to="/admin/passes"
        search={{ q: row.original.primaryEmail }}
        aria-label={`${row.original.passCount} passes held by ${row.original.primaryEmail}`}
      />
    ),
  },
  {
    header: 'Last sign-in',
    id: 'last',
    meta: { nowrap: true, hideBelow: 'lg', stackHidden: true },
    cell: ({ row }) => formatDateTime(row.original.lastLoginAt, '—'),
  },
];

export function UsersPage({
  search,
  onSearch,
}: {
  search: UsersSearch;
  onSearch: (next: UsersSearch) => void;
}) {
  // Debounced so each keystroke does not hit the API or the history stack.
  const [text, setText] = useDebouncedCommit(
    search.q ?? '',
    (next) => onSearch({ ...search, q: next.trim() || undefined }),
    300,
  );

  const list = useUserList(search);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const filtered = Boolean(search.q || search.status);

  return (
    <>
      <PageHeader title="Users" />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="Users"
          loading={list.isPending}
          fetching={list.isFetching && !list.isFetchingNextPage}
          data={rows}
          getRowId={(u) => u.id}
          filtered={filtered}
          toolbar={
            <FilterBar
              search={{ value: text, onChange: setText, placeholder: 'Search users' }}
              filters={[
                {
                  id: 'status',
                  label: 'Status',
                  value: search.status ?? ALL,
                  defaultValue: ALL,
                  options: [
                    { value: ALL, label: 'All' },
                    { value: 'active', label: 'Active' },
                    { value: 'disabled', label: 'Disabled' },
                  ],
                  onChange: (v) =>
                    onSearch({
                      ...search,
                      status: v === ALL ? undefined : (v as 'active' | 'disabled'),
                    }),
                },
              ]}
              onClear={() => {
                setText('');
                onSearch({});
              }}
            />
          }
          emptyFiltered={
            <FilteredEmpty
              entity="user"
              onClear={() => {
                setText('');
                onSearch({});
              }}
            />
          }
          empty={
            <EmptyState
              art="people"
              title="No users yet"
              description="Users appear after their first sign-in."
            />
          }
          footer={
            <LoadMore
              hasMore={Boolean(list.hasNextPage)}
              loading={list.isFetchingNextPage}
              onLoadMore={() => list.fetchNextPage()}
              shown={rows.length}
              noun={['user', 'users']}
            />
          }
          columns={COLUMNS}
        />
      )}
    </>
  );
}
