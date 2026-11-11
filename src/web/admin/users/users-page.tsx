import type { ColumnDef } from '@tanstack/react-table';
import { useMemo } from 'react';
import type { z } from 'zod';
import type { UserSummarySchema } from '@/shared/contracts/users.ts';
import { useDebouncedCommit } from '@/web/lib/debounce.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { formatCount, formatDateTime } from '@/web/lib/format.ts';
import {
  Badge,
  DataTable,
  EmptyState,
  EntityAvatar,
  ErrorState,
  FilterBar,
  LoadMore,
  MetaLink,
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
    header: 'Roles at last sign-in',
    id: 'roles',
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
    header: 'Owned passes',
    id: 'passes',
    meta: { numeric: true },
    cell: ({ row }) => (
      <div className="flex flex-col items-end gap-1">
        <span className="tabular-nums">{formatCount(row.original.passCount)}</span>
        <MetaLink
          to="/admin/passes"
          search={{ q: row.original.primaryEmail }}
          aria-label={`Search primary email ${row.original.primaryEmail} in the selected mode`}
          className="text-xs text-accent-fg"
        >
          Search primary email
        </MetaLink>
      </div>
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

  const clear = () => {
    setText('');
    onSearch({});
  };

  return (
    <>
      <PageHeader
        title="Platform accounts"
        description="Roles are from the last sign-in."
        meta={
          <>
            <Badge>Platform-wide</Badge>
            <span>All modes</span>
          </>
        }
      />
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
              search={{ value: text, onChange: setText, placeholder: 'Search accounts' }}
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
                  onChange: (value) =>
                    onSearch({
                      ...search,
                      status: value === ALL ? undefined : (value as 'active' | 'disabled'),
                    }),
                },
              ]}
              onClear={clear}
            />
          }
          emptyFiltered={
            <EmptyState art={ENTITY.user.art} variant="filtered" title="No users match" />
          }
          empty={
            <EmptyState
              art="people"
              title="No users yet"
              description="Users appear after their first sign-in."
            />
          }
          footer={<LoadMore query={list} shown={rows.length} noun={['user', 'users']} />}
          columns={COLUMNS}
        />
      )}
    </>
  );
}
