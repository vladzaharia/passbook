import { ChevronDown } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import type { ScannerSetup as ScannerDto } from '@/shared/contracts/scan-setups.ts';
import { cn } from '@/web/lib/cn.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, DataTable, EmptyState, ErrorState, LoadMore } from '@/web/ui/index.ts';
import { useNow } from '../../passes/detail/rel-time.tsx';
import { useScannerPages } from '../queries.ts';
import { useScanEvents } from '../scanner-api.ts';
import { scannerColumns } from './scanner-columns.tsx';
import { PairDialog, RevokeDialog } from './scanner-dialogs.tsx';

type Pages = ReturnType<typeof useScannerPages>;
export const flatScanners = (q: Pages): ScannerDto[] => q.data?.pages.flatMap((p) => p.items) ?? [];

/**
 * The Scanners tab: the org's scanners in the console's mode. Revoked ones sit behind "Show
 * revoked (n)", the same as API keys. The list refetches every 30 s while visible.
 */
export function ScannersTab({ live, newButton }: { live: Pages; newButton: ReactNode }) {
  const { orgId } = useOrgScope();
  const now = useNow();
  const events = useScanEvents(orgId);
  const [showRevoked, setShowRevoked] = useState(false);
  const revokedList = useScannerPages(orgId, true);
  const [pairing, setPairing] = useState<ScannerDto>();
  const [revoking, setRevoking] = useState<ScannerDto>();
  const eventName = useMemo(() => {
    const names = new Map((events.data?.items ?? []).map((e) => [e.id, e.name]));
    return (id: string) => names.get(id);
  }, [events.data]);
  const columns = useMemo(
    () =>
      scannerColumns(
        {
          onPair: setPairing,
          onRevoke: setRevoking,
        },
        now,
        eventName,
      ),
    [now, eventName],
  );

  const liveRows = flatScanners(live).filter((s) => s.status !== 'revoked');
  const revoked = flatScanners(revokedList).filter((s) => s.status === 'revoked');
  const rows = showRevoked ? [...liveRows, ...revoked] : liveRows;
  if (live.isError && liveRows.length === 0) {
    return <ErrorState error={live.error} onRetry={() => live.refetch()} />;
  }
  const more = revokedList.hasNextPage ? '+' : '';
  return (
    <>
      <div className="mb-4 flex min-w-0 items-start gap-3 rounded-lg border border-border bg-surface-raised p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg-strong">Scanners and displays</p>
          <p className="mt-1 text-sm text-fg-muted">
            Existing devices keep their setup. Create a session to add a Scanner, Operator or
            Customer display.
          </p>
        </div>
      </div>
      <DataTable
        caption="Scanners"
        loading={live.isPending}
        fetching={live.isFetching && !live.isFetchingNextPage}
        data={rows}
        getRowId={(s) => s.id}
        empty={
          <EmptyState
            art="phone"
            title="No devices yet"
            description="Create a session, then choose Scanner, Operator or Customer display when adding a device."
            action={newButton}
          />
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <LoadMore query={live} shown={liveRows.length} noun={['scanner', 'scanners']} scoped />
            {revoked.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-3"
                aria-expanded={showRevoked}
                iconEnd={
                  <ChevronDown
                    aria-hidden
                    className={cn('transition-transform', showRevoked && 'rotate-180')}
                  />
                }
                onClick={() => setShowRevoked((v) => !v)}
              >
                {showRevoked ? 'Hide revoked' : `Show revoked (${revoked.length}${more})`}
              </Button>
            ) : null}
          </div>
        }
        columns={columns}
      />
      <PairDialog key={pairing?.id} scanner={pairing} onClose={() => setPairing(undefined)} />
      <RevokeDialog scanner={revoking} onClose={() => setRevoking(undefined)} />
    </>
  );
}
