import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { type ScanRecordDto, ScanRecordListSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  StatusPill,
} from '@/web/ui/index.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { ScanFilters } from './scans/filters.tsx';
import {
  actionText,
  methodLabel,
  scanStatusKey,
  whereText,
  whoText,
} from './scans/outcome-copy.ts';
import { ScanDetail } from './scans/scan-detail.tsx';
import type { ScanningSearch } from './search.ts';

export function ScansTab({ search = {} }: { search?: ScanningSearch }) {
  const { orgId } = useOrgScope();
  const mode = useMode();
  return <ScopedScansTab key={`${orgId ?? ''}:${mode}`} search={search} mode={mode} />;
}

function ScopedScansTab({ search, mode }: { search: ScanningSearch; mode: Mode }) {
  const { orgId, membership, isLoading, isError } = useOrgScope();
  const allowed = Boolean(
    !isLoading && !isError && orgId && membership?.capabilities.includes('scanning:read'),
  );
  const canOperate = Boolean(allowed && membership?.capabilities.includes('passes:operate'));
  const [selected, setSelected] = useState<ScanRecordDto | null>(null);

  const range = search.range ?? 'today';
  const { q, scannerId, eventId, templateId, staffId, outcome, reason } = search;
  const [day, setDay] = useState(() => Date.now());
  useEffect(() => {
    const midnight = new Date(day);
    midnight.setHours(24, 0, 0, 0);
    const timer = window.setTimeout(
      () => setDay(Date.now()),
      Math.max(1, midnight.getTime() - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [day]);
  // Polling and pagination share one window; filter changes and local midnight start a new one.
  const filters = useMemo(() => {
    const start = new Date(range === 'today' ? day : Date.now());
    if (range === 'today') start.setHours(0, 0, 0, 0);
    else start.setDate(start.getDate() - (range === '7d' ? 7 : 30));
    return { q, from: start.getTime(), scannerId, eventId, templateId, staffId, outcome, reason };
  }, [range, day, q, scannerId, eventId, templateId, staffId, outcome, reason]);
  const query = useInfiniteQuery({
    queryKey: ['admin', 'scanning', 'scans', allowed ? orgId : null, mode, filters, allowed],
    enabled: allowed,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!allowed || !orgId) throw new Error('Choose an authorized organization.');
      return api.get('/api/v1/scans', ScanRecordListSchema, {
        query: {
          orgId,
          ...filters,
          cursor: pageParam,
          limit: 50,
        },
        signal,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const columns: DataColumnDef<ScanRecordDto>[] = [
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
      cell: ({ row }) => (
        <span className="block whitespace-normal break-words">
          {row.original.passTitle ??
            (row.original.reason === 'not_found' ? 'No pass matched' : 'Pass details unavailable')}
        </span>
      ),
    },
    {
      accessorKey: 'outcome',
      header: 'Result',
      cell: ({ row }) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <StatusPill status={scanStatusKey(row.original.outcome, row.original.undoneAt)} />
          {row.original.late ? <Badge>Late</Badge> : null}
        </span>
      ),
    },
    {
      accessorKey: 'actionLabel',
      header: 'Action',
      cell: ({ row }) => actionText(row.original),
    },
    {
      accessorKey: 'scannerName',
      header: 'Where',
      cell: ({ row }) => whereText(row.original),
    },
    { accessorKey: 'staffName', header: 'Who', cell: ({ row }) => whoText(row.original) },
    {
      accessorKey: 'method',
      header: 'Method',
      meta: { hideBelow: 'lg' },
      cell: ({ row }) => methodLabel(row.original.method),
    },
  ];
  if (!allowed || !orgId) {
    return <OrgChooser inline />;
  }
  if (query.isError && !query.isFetchNextPageError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <ScanFilters search={search} orgId={orgId} from={filters.from} />
      <DataTable
        caption="Scans"
        data={rows}
        columns={columns}
        loading={query.isPending}
        getRowId={(row) => row.id}
        onRowClick={setSelected}
        empty={
          <EmptyState
            art="activity"
            title={query.hasNextPage ? 'No visible scans yet' : 'No scans yet'}
            description={query.hasNextPage ? 'More results may be available.' : undefined}
          />
        }
      />
      <LoadMore query={query} shown={rows.length || undefined} noun={['scan', 'scans']} scoped />
      {selected ? (
        <ScanDetail
          row={selected}
          orgId={orgId}
          mode={mode}
          canOperate={canOperate}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}
