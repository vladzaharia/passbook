import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  LoadMore,
  PageHeader,
  Select,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../overview/format.ts';
import { roleLabel } from './labels.ts';
import { useUserList } from './queries.ts';

export interface UsersSearch {
  q?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
}

export function parseUsersSearch(raw: Record<string, unknown>): UsersSearch {
  const q = typeof raw.q === 'string' && raw.q.trim() ? raw.q.trim() : undefined;
  const status = raw.status === 'active' || raw.status === 'disabled' ? raw.status : undefined;
  return { q, status };
}

const ALL = 'all';

export function UsersPage({
  search,
  onSearch,
}: {
  search: UsersSearch;
  onSearch: (next: UsersSearch) => void;
}) {
  const [text, setText] = useState(search.q ?? '');
  useEffect(() => setText(search.q ?? ''), [search.q]);
  // Debounced so each keystroke does not hit the API or the history stack.
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === (search.q ?? '')) return;
    const t = setTimeout(() => onSearch({ ...search, q: trimmed || undefined }), 300);
    return () => clearTimeout(t);
  }, [text, search, onSearch]);

  const list = useUserList(search);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(search.q || search.status);

  return (
    <>
      <PageHeader title="Users" />
      <div className="mb-4 grid gap-2 sm:flex sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-subtle"
          />
          <Input
            type="search"
            aria-label="Search users"
            placeholder="Name or email"
            className="pl-8"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Select
          aria-label="Status"
          className="sm:w-44"
          value={search.status ?? ALL}
          onValueChange={(v) =>
            onSearch({ ...search, status: v === ALL ? undefined : (v as 'active' | 'disabled') })
          }
          options={[
            { value: ALL, label: 'Status: all' },
            { value: 'active', label: 'Active' },
            { value: 'disabled', label: 'Disabled' },
          ]}
        />
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <>
          <DataTable
            caption="Users"
            loading={list.isPending}
            data={rows}
            getRowId={(u) => u.id}
            empty={
              <EmptyState
                art="people"
                variant={filtered ? 'filtered' : 'empty'}
                title={filtered ? 'No users match' : 'No users yet'}
                description={filtered ? undefined : 'Users appear after their first sign-in.'}
                action={
                  filtered ? (
                    <Button variant="outline" onClick={() => onSearch({})}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            }
            columns={[
              {
                header: 'User',
                id: 'user',
                cell: ({ row }) => (
                  <div className="flex min-h-10 min-w-0 flex-col justify-center">
                    <Link
                      to="/admin/users/$userId"
                      params={{ userId: row.original.id }}
                      className="font-medium text-accent-fg hover:underline"
                    >
                      {row.original.name ?? row.original.primaryEmail}
                    </Link>
                    {row.original.name ? (
                      <span className="block truncate text-xs text-fg-muted">
                        {row.original.primaryEmail}
                      </span>
                    ) : null}
                  </div>
                ),
              },
              {
                header: 'Status',
                id: 'status',
                cell: ({ row }) => (
                  <StatusPill
                    status={row.original.status}
                    tone={row.original.status === 'active' ? 'success' : 'neutral'}
                  >
                    {row.original.status === 'active' ? 'Active' : 'Disabled'}
                  </StatusPill>
                ),
              },
              {
                header: 'Roles',
                id: 'roles',
                cell: ({ row }) => (
                  <span className="flex flex-wrap gap-1">
                    {row.original.lastRoles.map((r) => (
                      <Badge key={r}>{roleLabel(r)}</Badge>
                    ))}
                  </span>
                ),
              },
              {
                header: 'Last sign-in',
                id: 'last',
                meta: { nowrap: true },
                cell: ({ row }) => formatDateTime(row.original.lastLoginAt),
              },
              {
                header: 'Created',
                id: 'created',
                meta: { hideBelow: 'lg', stackHidden: true, nowrap: true },
                cell: ({ row }) => formatDateTime(row.original.createdAt),
              },
            ]}
          />
          <LoadMore
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onLoadMore={() => list.fetchNextPage()}
            shown={rows.length}
          />
        </>
      )}
    </>
  );
}
