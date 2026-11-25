import { useMemo, useRef } from 'react';
import { BELOW_MD, useMediaQuery } from '@/web/lib/media.ts';
import { useArrival } from '@/web/lib/motion.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { ActionButton, AuditRows } from './audit-rows.tsx';
import type { AuditEntry } from './entry-drawer.tsx';
import { actorRef, targetRef } from './labels.ts';
import type { useTenantAuditLog } from './queries.ts';
import { RefChip } from './ref-chip.tsx';

/** Cap long labels on narrower tables; the table remains scrollable when needed. */
const NARROW = 'max-xl:max-w-32';

/** The log as a table, or as rows below md. Platform and organization logs share it. */
export function AuditTable({
  log,
  orgName,
  showOrganization,
  filtered,
  scopedMore,
  onOpen,
  onClear,
}: {
  log: ReturnType<typeof useTenantAuditLog>;
  orgName: (id: string | null) => string | undefined;
  showOrganization: boolean;
  filtered: boolean;
  scopedMore: boolean;
  onOpen: (id: number) => void;
  onClear: () => void;
}) {
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  const narrow = useMediaQuery(BELOW_MD);
  const arrived = useArrival(log.isPending);
  const fetching = log.isPlaceholderData && log.isFetching;

  // Cells are components: columns rebuilt on every render would remount them and drop focus.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const columns = useMemo<DataColumnDef<AuditEntry>[]>(
    () => [
      {
        header: 'Action',
        id: 'action',
        cell: ({ row }) => (
          <ActionButton
            entry={row.original}
            onOpen={() => openRef.current(row.original.id)}
            wrap
            className="min-w-40"
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
      ...(showOrganization
        ? [
            {
              header: 'Organization',
              id: 'org',
              meta: { nowrap: true, hideBelow: 'lg' as const },
              cell: ({ row }: { row: { original: AuditEntry } }) =>
                row.original.orgId
                  ? (orgName(row.original.orgId) ?? 'Unknown organization')
                  : 'Not recorded',
            },
          ]
        : []),
      {
        header: 'Time',
        id: 'at',
        meta: { numeric: true },
        cell: ({ row }) => (
          <time
            dateTime={new Date(row.original.at).toISOString()}
            className="block min-w-24 text-xs text-fg-muted"
          >
            {formatDateTime(row.original.at)}
          </time>
        ),
      },
    ],
    [showOrganization, orgName],
  );

  const empty = <EmptyState inline art="log" mood="flat" title="No entries" />;
  const emptyFiltered = (
    <EmptyState
      art="log"
      inline
      variant="filtered"
      title="No entries match"
      action={
        <Button variant="ghost" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  );

  return (
    <Card>
      <CardHeader
        title="Recent events"
        actions={log.isPlaceholderData ? <Badge>Updating</Badge> : null}
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
              onOpen={onOpen}
              enter={arrived}
              orgName={orgName}
              showOrganization={showOrganization}
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
          onRowClick={(r) => onOpen(r.id)}
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
            scoped={scopedMore}
          />
        </div>
      )}
    </Card>
  );
}
