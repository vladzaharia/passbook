import type { ScannerDto } from '@/shared/contracts/scanners.ts';
import { DataTable, EmptyState, ErrorState, LoadMore, RowLink } from '@/web/ui/index.ts';
import type { useScannerPages } from '../queries.ts';

export const flatScanners = (q: ReturnType<typeof useScannerPages>): ScannerDto[] =>
  q.data?.pages.flatMap((p) => p.items) ?? [];

/** The Scanners tab: the org's scanners in the console's mode. */
export function ScannersTab({
  live,
  newButton,
}: {
  live: ReturnType<typeof useScannerPages>;
  newButton: React.ReactNode;
}) {
  const rows = flatScanners(live).filter((s) => s.status !== 'revoked');
  if (live.isError && rows.length === 0) {
    return <ErrorState error={live.error} onRetry={() => live.refetch()} />;
  }
  return (
    <DataTable
      caption="Scanners"
      loading={live.isPending}
      fetching={live.isFetching && !live.isFetchingNextPage}
      data={rows}
      getRowId={(s) => s.id}
      empty={
        <EmptyState
          art="phone"
          title="No scanners yet"
          description="Pair a phone, tablet or computer to check passes."
          action={newButton}
        />
      }
      footer={<LoadMore query={live} shown={rows.length} noun={['scanner', 'scanners']} scoped />}
      columns={[
        {
          header: 'Name',
          id: 'name',
          cell: ({ row }) => (
            <RowLink
              to="/admin/scanning/scanners/$scannerId"
              params={{ scannerId: row.original.id }}
            >
              {row.original.name}
            </RowLink>
          ),
        },
      ]}
    />
  );
}
