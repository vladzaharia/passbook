import { BELOW_MD, useMediaQuery } from '@/web/lib/media.ts';
import { useArrival } from '@/web/lib/motion.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useOrgList } from '../orgs/queries.ts';
import { AuditFilters } from './audit-filters.tsx';
import { ActionButton, AuditRows } from './audit-rows.tsx';
import type { AuditSearch } from './audit-search.ts';
import { EntryDrawer } from './entry-drawer.tsx';
import { actorRef, targetRef } from './labels.ts';
import { useAuditLog } from './queries.ts';
import { RefChip } from './ref-chip.tsx';

/** Below 1280 the cells cap their width so Action, Actor, Target and Time fit without scrolling. */
const NARROW = 'max-xl:max-w-44';

export function AuditPage({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
}) {
  const scope = useOrgScope();
  const orgs = useOrgList();
  const orgName = (id: string | null) =>
    id ? orgs.data?.items.find((o) => o.id === id)?.name : undefined;
  const { entry, ...filters } = search;
  // An org deep link wins; otherwise the top-bar scope applies.
  const orgId = filters.orgId ?? scope.orgId;
  const log = useAuditLog({ ...filters, orgId });
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  const narrow = useMediaQuery(BELOW_MD);
  const arrived = useArrival(log.isPending);
  const selected = entry === undefined ? undefined : rows.find((r) => r.id === entry);
  const filtered = Object.values(filters).some((v) => v !== undefined);
  const open = (id: number) => onSearch({ ...filters, entry: id });
  const fetching = log.isPlaceholderData && log.isFetching;

  const names = {
    actor: rows.find((r) => r.actorId === filters.actorId)?.actorLabel ?? undefined,
    target: rows.find((r) => r.targetId === filters.targetId)?.targetLabel ?? undefined,
    org: orgName(filters.orgId ?? null),
  };
  const toolbar = <AuditFilters search={filters} onSearch={onSearch} names={names} />;
  const empty = <EmptyState art="log" mood="flat" title="No entries" />;
  const emptyFiltered = (
    <EmptyState
      art="log"
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
      <PageHeader title="Audit log" />
      {log.isError ? (
        <ErrorState error={log.error} onRetry={() => log.refetch()} />
      ) : narrow ? (
        log.isPending ? (
          <SkeletonRows label="Loading audit log" />
        ) : rows.length === 0 ? (
          filtered ? (
            <>
              {toolbar}
              {emptyFiltered}
            </>
          ) : (
            empty
          )
        ) : (
          <>
            {toolbar}
            <div aria-busy={fetching || undefined}>
              <AuditRows rows={rows} onOpen={open} enter={arrived} />
            </div>
          </>
        )
      ) : (
        <DataTable
          caption="Audit log"
          stack={false}
          loading={log.isPending}
          fetching={fetching}
          data={rows}
          getRowId={(r) => String(r.id)}
          onRowClick={(r) => open(r.id)}
          toolbar={toolbar}
          filtered={filtered}
          empty={empty}
          emptyFiltered={emptyFiltered}
          columns={[
            {
              header: 'Action',
              id: 'action',
              cell: ({ row }) => (
                <ActionButton
                  entry={row.original}
                  onOpen={() => open(row.original.id)}
                  className={NARROW}
                />
              ),
            },
            {
              header: 'Actor',
              id: 'actor',
              meta: { nowrap: true, hideBelow: 'lg' },
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
                    meta: { hideBelow: 'xl' as const, nowrap: true },
                    cell: ({ row }: { row: { original: (typeof rows)[number] } }) =>
                      orgName(row.original.orgId) ?? <span className="text-fg-subtle">—</span>,
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
          ]}
        />
      )}
      {log.isError || rows.length === 0 ? null : (
        <LoadMore
          query={log}
          shown={rows.length}
          noun={['entry', 'entries']}
          scoped={!filters.orgId}
        />
      )}
      <EntryDrawer entry={selected} orgName={orgName} onClose={() => onSearch(filters)} />
    </>
  );
}
