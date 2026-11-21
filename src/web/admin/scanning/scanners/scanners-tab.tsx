import { ChevronDown } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import type { ScannerSetup as ScannerDto } from '@/shared/contracts/scan-setups.ts';
import { cn } from '@/web/lib/cn.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, DataTable, EmptyState, ErrorState, LoadMore } from '@/web/ui/index.ts';
import { useNow } from '../../../ui/rel-time.tsx';
import { useScannerPages } from '../queries.ts';
import { useScanEvents } from '../scanner-api.ts';
import { useScanningSessions } from '../sessions/api.ts';
import { scannerColumns } from './scanner-columns.tsx';

type Pages = ReturnType<typeof useScannerPages>;
export const flatScanners = (q: Pages): ScannerDto[] => q.data?.pages.flatMap((p) => p.items) ?? [];

/**
 * The Scanners tab: the org's scanners in the console's mode. Revoked ones sit behind "Show
 * revoked (n)", the same as API keys. The list refetches every 30 s while visible.
 */
export function ScannersTab({ live, newButton }: { live: Pages; newButton: ReactNode }) {
  const { orgId, membership } = useOrgScope();
  const _canManage = Boolean(orgId && membership?.capabilities.includes('scanning:manage'));
  const now = useNow();
  const events = useScanEvents(orgId, Boolean(orgId));
  const [showRevoked, setShowRevoked] = useState(false);
  const revokedList = useScannerPages(orgId, true, Boolean(orgId));
  const sessions = useScanningSessions(orgId);
  const sessionOf = useMemo(() => {
    const byId = new Map(
      (sessions.data?.pages.flatMap((p) => p.items) ?? []).map((s) => [s.id, s]),
    );
    return (id: string | undefined) => (id ? byId.get(id) : undefined);
  }, [sessions.data]);
  const eventName = useMemo(() => {
    const names = new Map(
      (events.data?.items ?? []).filter((e) => e.orgId === orgId).map((e) => [e.id, e.name]),
    );
    return (id: string) => names.get(id);
  }, [events.data, orgId]);
  const columns = useMemo(
    () => scannerColumns(now, eventName, sessionOf),
    [now, eventName, sessionOf],
  );

  const liveRows = flatScanners(live).filter((s) => s.orgId === orgId && s.status !== 'revoked');
  const revoked = flatScanners(revokedList).filter(
    (s) => s.orgId === orgId && s.status === 'revoked',
  );
  const rows = showRevoked ? [...liveRows, ...revoked] : liveRows;
  if (live.isError && liveRows.length === 0) {
    return <ErrorState error={live.error} onRetry={() => live.refetch()} />;
  }
  const more = revokedList.hasNextPage ? '+' : '';
  return (
    <DataTable
      caption="Scanners"
      loading={live.isPending}
      fetching={live.isFetching && !live.isFetchingNextPage}
      data={rows}
      getRowId={(s) => s.id}
      empty={<EmptyState art="phone" title="No devices yet" action={newButton} />}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <LoadMore query={live} shown={liveRows.length} noun={['device', 'devices']} scoped />
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
  );
}
