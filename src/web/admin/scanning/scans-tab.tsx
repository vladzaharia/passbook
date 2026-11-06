import { useInfiniteQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { type ScanRecordDto, ScanRecordListSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, DataTable, EmptyState, ErrorState, LoadMore, StatusPill } from '@/web/ui/index.ts';
import { ScanFilters } from './scans/filters.tsx';
import { ScanDetail } from './scans/scan-detail.tsx';
import type { ScanningSearch } from './search.ts';

export function ScansTab({ search = {} }: { search?: ScanningSearch }) {
  const { orgId } = useOrgScope();
  const [selected, setSelected] = useState<ScanRecordDto | null>(null);

  const from = new Date();
  if (!search.range || search.range === 'today') from.setHours(0, 0, 0, 0);
  else from.setDate(from.getDate() - (search.range === '7d' ? 7 : 30));
  const query = useInfiniteQuery({
    queryKey: ['admin', 'scanning', 'scans', orgId, search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/scans', ScanRecordListSchema, {
        query: {
          orgId,
          q: search.q,
          from: from.getTime(),
          scannerId: search.scannerId,
          eventId: search.eventId,
          staffId: search.staffId,
          outcome: search.outcome,
          reason: search.reason,
          cursor: pageParam,
          limit: 50,
        },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const columns: ColumnDef<ScanRecordDto>[] = [
    {
      accessorKey: 'at',
      header: 'When',
      cell: ({ row }) => (
        <Button variant="link" onClick={() => setSelected(row.original)}>
          {formatDateTime(row.original.at)}
        </Button>
      ),
    },
    {
      accessorKey: 'passTitle',
      header: 'Pass',
      cell: ({ row }) => row.original.passTitle ?? 'Unknown code',
    },
    {
      accessorKey: 'outcome',
      header: 'Result',
      cell: ({ row }) => (
        <StatusPill status={row.original.undoneAt ? 'undone' : row.original.outcome} />
      ),
    },
    {
      accessorKey: 'actionLabel',
      header: 'What',
      cell: ({ row }) => row.original.actionLabel ?? row.original.reason,
    },
    {
      accessorKey: 'scannerName',
      header: 'Where',
      cell: ({ row }) => row.original.scannerName ?? 'Admin console',
    },
    { accessorKey: 'staffName', header: 'Who' },
    { accessorKey: 'method', header: 'How' },
  ];
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <ScanFilters search={search} orgId={orgId} />
      <DataTable
        caption="Scans"
        data={rows}
        columns={columns}
        loading={query.isPending}
        getRowId={(row) => row.id}
        empty={<EmptyState art="activity" title="No scans yet" />}
        footer={<LoadMore query={query} shown={rows.length} noun={['scan', 'scans']} scoped />}
      />
      {selected ? <ScanDetail row={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
