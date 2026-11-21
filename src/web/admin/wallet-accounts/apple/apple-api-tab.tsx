import { useMemo } from 'react';
import type { z } from 'zod';
import type { AppleCallSchema } from '@/shared/contracts/identities.ts';
import { formatCount } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { DataTable, EmptyState, ErrorState, RelTime, StatusPill } from '@/web/ui/index.ts';
import { useAppleCalls } from './managed-queries.ts';

type Call = z.infer<typeof AppleCallSchema>;

/** The Apple provisioner's ledger: every call it made to App Store Connect. */
export function AppleApiPanel() {
  const query = useAppleCalls();
  const now = Date.now();
  const columns = useMemo<DataColumnDef<Call, never>[]>(
    () => [
      {
        header: 'When',
        id: 'at',
        meta: { nowrap: true },
        cell: ({ row }) => <RelTime at={row.original.at} now={now} />,
      },
      {
        header: 'Call',
        id: 'method',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.method}</span>,
      },
      {
        header: 'Target',
        id: 'target',
        meta: { hideBelow: 'md' },
        cell: ({ row }) => (
          <span className="truncate font-mono text-xs">{row.original.target ?? '—'}</span>
        ),
      },
      {
        header: 'Status',
        id: 'status',
        cell: ({ row }) =>
          row.original.status === null ? (
            '—'
          ) : (
            <StatusPill status={row.original.status === 'ok' ? 'verified' : 'failing'}>
              {row.original.status}
            </StatusPill>
          ),
      },
      {
        header: 'Time',
        id: 'duration',
        meta: { numeric: true, hideBelow: 'lg' },
        cell: ({ row }) =>
          row.original.durationMs === null ? '—' : `${formatCount(row.original.durationMs)} ms`,
      },
    ],
    [now],
  );
  if (query.isError)
    return <ErrorState subject="calls" error={query.error} onRetry={() => query.refetch()} />;
  if (query.data && !query.data.available)
    return <EmptyState art="certificate" title="Provisioner not connected" />;
  return (
    <DataTable
      caption="Apple API calls"
      loading={query.isPending}
      fetching={query.isFetching && !query.isPending}
      data={query.data?.items ?? []}
      getRowId={(c) => String(c.id)}
      empty={<EmptyState art="certificate" title="No calls" />}
      columns={columns}
    />
  );
}
