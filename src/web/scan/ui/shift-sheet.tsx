import { useQuery } from '@tanstack/react-query';
import { formatTime } from '../../lib/format.ts';
import { Buddy } from '../../ui/art/buddy.tsx';
import { Button } from '../../ui/button.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { ScanApi } from '../api/scan-api.ts';

export function ShiftSheet({
  open,
  ending,
  api,
  since,
  onClose,
  onEnd,
  pending,
}: {
  open: boolean;
  ending: boolean;
  api: ScanApi;
  since: number;
  onClose: () => void;
  onEnd: () => void;
  pending: number;
}) {
  const query = useQuery({
    queryKey: ['scan', 'shift', since],
    queryFn: ({ signal }) => api.summary(since, { signal }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const summary = query.data;
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetContent title={ending ? 'End shift?' : 'This shift'} className="scan-detail-sheet">
        <div className="flex flex-col gap-5 p-5">
          <Buddy scene="scan" pose="count" size="lg" mood="happy" />
          <p className="text-sm text-fg-muted">Since {formatTime(since)}</p>
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => query.refetch()} />
          ) : null}
          {summary ? (
            <>
              <dl className="grid grid-cols-2 gap-4">
                {[
                  ['Scans', summary.total],
                  ['Done', summary.ok],
                  ['Heads-up', summary.headsUp],
                  ['Refused', summary.refused],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-sm text-fg-muted">{label}</dt>
                    <dd className="text-3xl font-semibold tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              {summary.byAction.map((action) => (
                <p key={action.actionId}>
                  {action.label}{' '}
                  <strong className="float-right tabular-nums">{action.count}</strong>
                </p>
              ))}
            </>
          ) : null}
          {ending ? (
            <>
              <p className="text-sm">
                This device stays paired. Start a new shift when you’re ready.
              </p>
              {pending ? (
                <p role="status">{pending} scans need confirmation. Keep this shift open.</p>
              ) : null}
              <Button disabled={pending > 0} onClick={onEnd}>
                End shift
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Keep scanning
              </Button>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
