import type { ColumnDef } from '@tanstack/react-table';
import { useCallback, useMemo, useRef } from 'react';
import { BELOW_MD, useMediaQuery } from '@/web/lib/media.ts';
import { useArrival } from '@/web/lib/motion.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useOrgPages } from '../orgs/org-pages.ts';
import { useOrgList } from '../orgs/queries.ts';
import { AuditFilters } from './audit-filters.tsx';
import { ActionButton, AuditRows } from './audit-rows.tsx';
import type { AuditSearch } from './audit-search.ts';
import { type AuditEntry, EntryDrawer } from './entry-drawer.tsx';
import { actorRef, targetRef } from './labels.ts';
import { usePlatformAuditLog } from './queries.ts';
import { RefChip } from './ref-chip.tsx';

/** Cap long labels on narrower tables; the table remains scrollable when needed. */
const NARROW = 'max-xl:max-w-44';

export function AuditPage({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
}) {
  const directory = useOrgPages();
  const orgs = useOrgList();
  const orgNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const org of orgs.data?.items ?? []) names.set(org.id, org.name);
    for (const page of directory.data?.pages ?? []) {
      for (const org of page.items) names.set(org.id, org.name);
    }
    return names;
  }, [directory.data, orgs.data]);
  const orgName = useCallback(
    (id: string | null) => (id ? orgNames.get(id) : undefined),
    [orgNames],
  );
  const { entry, ...filters } = search;
  const orgId = filters.filterOrgId;
  const log = usePlatformAuditLog(filters);
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  const narrow = useMediaQuery(BELOW_MD);
  const arrived = useArrival(log.isPending);
  const selected = entry === undefined ? undefined : rows.find((r) => r.id === entry);
  const filtered = Object.values(filters).some((v) => v !== undefined);
  const open = (id: number) => onSearch({ ...filters, entry: id });
  const fetching = log.isPlaceholderData && log.isFetching;

  // Cells are components: columns rebuilt on every render would remount them and drop focus.
  const openRef = useRef(open);
  openRef.current = open;
  const columns = useMemo<ColumnDef<AuditEntry>[]>(
    () => [
      {
        header: 'Action',
        id: 'action',
        cell: ({ row }) => (
          <ActionButton
            entry={row.original}
            onOpen={() => openRef.current(row.original.id)}
            className={NARROW}
          />
        ),
      },
      {
        header: 'Actor',
        id: 'actor',
        meta: { nowrap: true },
        cell: ({ row }) => <RefChip value={actorRef(row.original)} className={NARROW} />,
      },
      {
        header: 'Target',
        id: 'target',
        meta: { nowrap: true },
        cell: ({ row }) => {
          const target = targetRef(row.original);
          return target ? (
            <RefChip value={target} className={NARROW} />
          ) : (
            <span className="text-fg-subtle">—</span>
          );
        },
      },
      ...(orgId
        ? []
        : [
            {
              header: 'Organization',
              id: 'org',
              meta: { nowrap: true },
              cell: ({ row }: { row: { original: (typeof rows)[number] } }) =>
                row.original.orgId
                  ? (orgName(row.original.orgId) ?? row.original.orgId)
                  : 'Not recorded',
            },
          ]),
      {
        header: 'Time',
        id: 'at',
        meta: { numeric: true },
        cell: ({ row }) => (
          <time
            dateTime={new Date(row.original.at).toISOString()}
            className="text-xs text-fg-muted"
          >
            {formatDateTime(row.original.at)}
          </time>
        ),
      },
    ],
    [orgId, orgName],
  );

  const names = {
    actor: rows.find((r) => r.actorId === filters.actorId)?.actorLabel ?? undefined,
    target: rows.find((r) => r.targetId === filters.targetId)?.targetLabel ?? undefined,
    org: orgName(filters.filterOrgId ?? null),
  };
  const empty = <EmptyState inline art="log" mood="flat" title="No entries" />;
  const emptyFiltered = (
    <EmptyState
      art="log"
      inline
      variant="filtered"
      title="No entries match"
      action={
        <Button variant="ghost" onClick={() => onSearch({})}>
          Clear filters
        </Button>
      }
    />
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        breadcrumbs={[{ label: 'Overview', to: '/admin' }, { label: 'Audit log' }]}
        meta={
          <>
            <Badge>Platform administrator</Badge>
            <Badge className="max-w-full break-words whitespace-normal">
              Organization filter: {orgId ? (orgName(orgId) ?? orgId) : 'All organizations'}
            </Badge>
          </>
        }
      />
      <Card className="mb-6">
        <CardBody>
          <AuditFilters search={filters} onSearch={onSearch} names={names} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Recent events"
          actions={
            log.isPlaceholderData ? (
              <Badge>Updating</Badge>
            ) : rows.length > 0 ? (
              <Badge>{rows.length} loaded</Badge>
            ) : null
          }
        />
        {log.isError && rows.length === 0 ? (
          <ErrorState
            error={log.error}
            onRetry={() => log.refetch()}
            className="rounded-none border-0 bg-transparent shadow-none"
          />
        ) : narrow ? (
          log.isPending ? (
            <div className="p-4">
              <SkeletonRows label="Loading audit log" />
            </div>
          ) : rows.length === 0 ? (
            filtered ? (
              emptyFiltered
            ) : (
              empty
            )
          ) : (
            <div aria-busy={fetching || undefined}>
              <AuditRows
                rows={rows}
                onOpen={open}
                enter={arrived}
                orgName={orgName}
                showOrganization={!orgId}
              />
            </div>
          )
        ) : (
          <DataTable
            caption="Audit log"
            bare
            stack={false}
            loading={log.isPending}
            fetching={fetching}
            data={rows}
            getRowId={(r) => String(r.id)}
            onRowClick={(r) => open(r.id)}
            filtered={filtered}
            empty={empty}
            emptyFiltered={emptyFiltered}
            columns={columns}
          />
        )}
        {rows.length === 0 ? null : (
          <div className="px-4 pb-4">
            <LoadMore
              query={log}
              shown={rows.length}
              noun={['entry', 'entries']}
              scoped={!filters.filterOrgId}
            />
          </div>
        )}
      </Card>
      <EntryDrawer entry={selected} orgName={orgName} onClose={() => onSearch(filters)} />
    </>
  );
}
