import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { useDebouncedCommit } from '@/web/lib/debounce.ts';
import { formatDay } from '@/web/lib/format.ts';
import {
  Button,
  DataTable,
  EmptyState,
  EntityAvatar,
  ErrorState,
  FilterBar,
  FilteredEmpty,
  LoadMore,
  PageHeader,
  StatusPill,
} from '@/web/ui/index.ts';
import { CreateOrgDialog } from './create-org-dialog.tsx';
import { useOrgList } from './queries.ts';

export { slugify } from './create-org-dialog.tsx';

type Org = z.infer<typeof OrgSummarySchema>;

export function OrgStatus({ status }: { status: 'active' | 'suspended' | 'deleted' }) {
  return status === 'suspended' ? (
    <StatusPill status="suspended" tone="warning">
      Suspended
    </StatusPill>
  ) : (
    <StatusPill status={status === 'active' ? 'active' : 'disabled'} />
  );
}

const COLUMNS: ColumnDef<Org, never>[] = [
  {
    header: 'Organization',
    id: 'name',
    cell: ({ row }) => (
      <div className="flex min-h-10 min-w-0 items-center gap-3">
        <EntityAvatar
          kind="org"
          id={row.original.id}
          name={row.original.name}
          accent={row.original.branding.accent}
        />
        <div className="min-w-0">
          <Link
            to="/admin/orgs/$orgId"
            params={{ orgId: row.original.id }}
            className="block truncate font-medium text-accent-fg hover:underline"
          >
            {row.original.name}
          </Link>
          <span className="block truncate font-mono text-xs text-fg-muted">
            {row.original.slug}
          </span>
        </div>
      </div>
    ),
  },
  {
    header: 'Status',
    id: 'status',
    cell: ({ row }) => <OrgStatus status={row.original.status} />,
  },
  {
    header: 'Passes',
    id: 'passes',
    meta: { numeric: true },
    cell: ({ row }) => row.original.counts.passes.toLocaleString(),
  },
  {
    header: 'Templates',
    id: 'templates',
    meta: { numeric: true, hideBelow: 'lg', stackHidden: true },
    cell: ({ row }) => row.original.counts.templates.toLocaleString(),
  },
  {
    header: 'Connections',
    id: 'connections',
    meta: { numeric: true, hideBelow: 'lg', stackHidden: true },
    cell: ({ row }) => row.original.counts.connections.toLocaleString(),
  },
  {
    header: 'Created',
    id: 'created',
    meta: { hideBelow: 'lg', stackHidden: true, nowrap: true },
    cell: ({ row }) => formatDay(row.original.createdAt),
  },
];

export function OrgsPage({
  search = {},
  onSearch = () => undefined,
}: {
  search?: { q?: string | undefined };
  onSearch?: (next: { q?: string | undefined }) => void;
}) {
  const [text, setText] = useDebouncedCommit(
    search.q ?? '',
    (next) => onSearch({ q: next.trim() || undefined }),
    300,
  );
  const list = useOrgList(search.q);
  const [creating, setCreating] = useState(false);
  const rows = list.data?.items ?? [];
  const empty = !list.isPending && rows.length === 0 && !search.q;
  const clear = () => {
    setText('');
    onSearch({});
  };
  const create = (variant: 'primary' | 'outline') => (
    <Button variant={variant} iconStart={<Plus aria-hidden />} onClick={() => setCreating(true)}>
      New organization
    </Button>
  );
  return (
    <>
      <PageHeader title="Organizations" actions={create(empty ? 'outline' : 'primary')} />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="Organizations"
          loading={list.isPending}
          fetching={list.isFetching}
          data={rows}
          getRowId={(o) => o.id}
          filtered={Boolean(search.q)}
          toolbar={
            <FilterBar
              search={{ value: text, onChange: setText, placeholder: 'Search organizations' }}
              filters={[]}
              onClear={clear}
            />
          }
          emptyFiltered={<FilteredEmpty entity="org" onClear={clear} />}
          empty={<EmptyState art="building" title="No organizations" action={create('primary')} />}
          footer={
            <LoadMore
              hasMore={false}
              onLoadMore={() => undefined}
              shown={rows.length}
              noun={['organization', 'organizations']}
            />
          }
          columns={COLUMNS}
        />
      )}
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
