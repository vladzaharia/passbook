import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { ScanOutcomeSchema } from '@/shared/contracts/scan.ts';
import { type ScanRecordDto, ScanRecordListSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { scanId } from '@/web/scan/platform/id.ts';
import {
  Button,
  Callout,
  DataTable,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  LoadMore,
} from '@/web/ui/index.ts';
import type { ScanningSearch } from './search.ts';

export function ScansTab({ search = {} }: { search?: ScanningSearch }) {
  const { orgId } = useOrgScope();
  const [selected, setSelected] = useState<ScanRecordDto | null>(null);
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ['admin', 'scanning', 'scans', orgId, search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/scans', ScanRecordListSchema, {
        query: {
          orgId,
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
  const undo = useMutation({
    mutationFn: (row: ScanRecordDto) =>
      api.post(`/api/v1/scans/${encodeURIComponent(row.id)}/undo`, ScanOutcomeSchema, {
        idempotencyKey: scanId(),
      }),
    onSuccess: async () => {
      setSelected(null);
      await client.invalidateQueries({ queryKey: ['admin', 'scanning', 'scans'] });
    },
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
    { accessorKey: 'passTitle', header: 'Pass' },
    { accessorKey: 'outcome', header: 'Result' },
    { accessorKey: 'actionLabel', header: 'Action' },
    { accessorKey: 'scannerName', header: 'Scanner' },
  ];
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <DataTable
        caption="Scans"
        data={rows}
        columns={columns}
        loading={query.isPending}
        getRowId={(row) => row.id}
        empty={<EmptyState art="activity" title="No scans yet" />}
        footer={<LoadMore query={query} shown={rows.length} noun={['scan', 'scans']} scoped />}
      />
      <Dialog
        open={selected !== null}
        onOpenChange={(value) => {
          if (!value) setSelected(null);
        }}
      >
        <DialogContent title="Scan" size="sm">
          {selected ? (
            <div className="flex flex-col gap-3">
              <p>{selected.passTitle ?? 'Unknown pass'}</p>
              <p>{selected.actionLabel ?? selected.reason ?? selected.outcome}</p>
              <p>
                {formatDateTime(selected.at)} · {selected.scannerName ?? 'Admin'}
              </p>
              {selected.undoneAt ? (
                <p>Undone {formatDateTime(selected.undoneAt)}</p>
              ) : selected.kind === 'check_in' && selected.outcome === 'ok' ? (
                <Button
                  variant="secondary"
                  loading={undo.isPending}
                  onClick={() => undo.mutate(selected)}
                >
                  Undo check-in
                </Button>
              ) : null}
              {undo.isError ? <Callout tone="danger">{errorMessage(undo.error)}</Callout> : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
