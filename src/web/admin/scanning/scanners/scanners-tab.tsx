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
import { draftOf, type ScannerDraft } from './scanner-draft.ts';

type Pages = ReturnType<typeof useScannerPages>;
export const flatScanners = (q: Pages): ScannerDto[] => q.data?.pages.flatMap((p) => p.items) ?? [];

/** The Duplicate draft: the same settings under "Front door 2"; nothing of the pairing. */
export const duplicateDraft = (s: ScannerDto): ScannerDraft => ({
  ...draftOf(s),
  name: `${s.name} 2`.slice(0, 40),
  adminUserId: '',
});

/**
 * The Scanners tab: the org's scanners in the console's mode. Revoked ones sit behind "Show
 * revoked (n)", the same as API keys. The list refetches every 30 s while visible.
 */
export function ScannersTab({
  live,
  newButton,
  onDuplicate,
}: {
  live: Pages;
  newButton: ReactNode;
  onDuplicate: (draft: ScannerDraft) => void;
}) {
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
          onDuplicate: (s) => onDuplicate(duplicateDraft(s)),
          onRevoke: setRevoking,
        },
        now,
        eventName,
      ),
    [now, eventName, onDuplicate],
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
