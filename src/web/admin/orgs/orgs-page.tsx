import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { useDebouncedCommit } from '@/web/lib/debounce.ts';
import { formatCount, formatDay } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Button,
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
import { CreateOrgDialog } from './create-org-dialog.tsx';
import { useOrgPages } from './org-pages.ts';
import type { PlatformOrgSummarySchema } from './queries.ts';

export { slugify } from './create-org-dialog.tsx';

type Org = z.infer<typeof PlatformOrgSummarySchema>;

export function OrgStatus({ status }: { status: 'active' | 'suspended' | 'deleted' }) {
  return <StatusPill status={status} />;
}

const NOUN = {
  passes: ['pass', 'passes'],
  templates: ['template', 'templates'],
  connections: ['connection', 'connections'],
} as const;

/**
 * The count opens that list scoped to the org (`?orgId=` is the top-bar scope), but only for an
 * org the admin is a member of: any other scope is Forbidden. Other orgs show a plain number.
 */
function countLink(org: Org, key: keyof typeof NOUN, to: string, member: boolean) {
  const n = org.counts[key];
  const capped = org.countsCapped && n >= 100_000;
  return (
    <span className="inline-flex items-baseline">
      {member ? (
        <CountLink
          count={n}
          to={to}
          search={{ orgId: org.id }}
          aria-label={`${capped ? 'At least ' : ''}${formatCount(n)} ${NOUN[key][n === 1 ? 0 : 1]} in ${org.name}`}
        />
      ) : (
        <span className="tabular-nums">{formatCount(n)}</span>
      )}
      {capped ? <span aria-hidden>+</span> : null}
    </span>
  );
}

const columnsFor = (isMember: (orgId: string) => boolean): ColumnDef<Org, never>[] => [
  {
    header: 'Organization',
    id: 'name',
    cell: ({ row }) => (
      <div className="flex min-h-10 min-w-0 items-center gap-3">
        <EntityAvatar kind="org" id={row.original.id} name={row.original.name} />
        <div className="min-w-0">
          <RowLink to="/admin/orgs/$orgId" params={{ orgId: row.original.id }}>
            {row.original.name}
          </RowLink>
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
    cell: ({ row }) =>
      countLink(row.original, 'passes', '/admin/passes', isMember(row.original.id)),
  },
  {
    header: 'Templates',
    id: 'templates',
    meta: { numeric: true, hideBelow: 'lg', stackHidden: true },
    cell: ({ row }) =>
      countLink(row.original, 'templates', '/admin/templates', isMember(row.original.id)),
  },
  {
    header: 'Connections',
    id: 'connections',
    meta: { numeric: true, hideBelow: 'lg', stackHidden: true },
    cell: ({ row }) =>
      countLink(row.original, 'connections', '/admin/connections', isMember(row.original.id)),
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
  openNew = false,
  onOpenNewConsumed,
}: {
  search?: { q?: string | undefined };
  onSearch?: (next: { q?: string | undefined }) => void;
  openNew?: boolean;
  onOpenNewConsumed?: () => void;
}) {
  const [text, setText] = useDebouncedCommit(
    search.q ?? '',
    (next) => onSearch({ q: next.trim() || undefined }),
    300,
  );
  const list = useOrgPages(search.q);
  const { memberships } = useOrgScope();
  const columns = useMemo(
    () => columnsFor((id) => memberships.some((m) => m.orgId === id)),
    [memberships],
  );
  const [creating, setCreating] = useState(false);
  const consumedOpenNew = useRef(false);
  useEffect(() => {
    if (!openNew) {
      consumedOpenNew.current = false;
    } else if (!consumedOpenNew.current) {
      consumedOpenNew.current = true;
      setCreating(true);
      onOpenNewConsumed?.();
    }
  }, [openNew, onOpenNewConsumed]);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
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
      <PageHeader
        title="Organization directory"
        breadcrumbs={[{ label: 'Platform', to: '/admin' }, { label: 'Organizations' }]}
        actions={create(empty ? 'outline' : 'primary')}
      />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="Organizations"
          loading={list.isPending}
          fetching={list.isFetching && !list.isFetchingNextPage}
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
            <LoadMore query={list} shown={rows.length} noun={['organization', 'organizations']} />
          }
          columns={columns}
        />
      )}
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
