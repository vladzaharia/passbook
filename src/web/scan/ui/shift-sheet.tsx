import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { formatTime } from '../../lib/format.ts';
import { PHONE, useMediaQuery } from '../../lib/media.ts';
import { Buddy } from '../../ui/art/buddy.tsx';
import { Button } from '../../ui/button.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import type { Counts, ScanState } from '../machine/types.ts';
import type { QueueView } from '../offline/queue-view.ts';
import { OfflineStatus } from './offline-status.tsx';
import { Handover, type Scope, Totals } from './shift-parts.tsx';
import { ShiftTray } from './shift-tray.tsx';

export function ShiftSheet({
  open,
  ending,
  api,
  since,
  sessionTotals = false,
  onClose,
  onEnd,
  pending,
  offline,
  focus,
  counts,
  onEnding,
}: {
  /** The door's count, for the tray's bar. */
  counts?: Counts | null;
  /** The tray's End shift: asks to end (the confirm is this sheet with `ending`). */
  onEnding?: () => void;
  open: boolean;
  ending: boolean;
  /** `queue`: scrolled to the offline queue when it opens (the strip's View). */
  focus?: 'queue';
  api: ScanApi;
  since: number;
  /** A Manager in a session may switch to the whole session's totals. */
  sessionTotals?: boolean;
  onClose: () => void;
  onEnd: () => void;
  pending: number;
  /** The offline mode, the list's age and what is queued; absent in tests that do not care. */
  offline?: {
    state: ScanState['offline'];
    queue: ScanState['queue'];
    onSync: () => void;
    /** What is saved on the device, read through the offline helpers. */
    rows?: () => Promise<QueueView[]>;
  };
}) {
  const [scope, setScope] = useState<Scope>('device');
  const query = useQuery({
    queryKey: ['scan', 'shift', since, scope],
    queryFn: ({ signal }) => api.summary(since, { signal }, scope),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const toQueue = useCallback(
    (el: HTMLElement | null) => {
      if (el && focus === 'queue') el.scrollIntoView?.({ block: 'start' });
    },
    [focus],
  );
  const summary = query.data;
  const timeZone = summary?.timeZone ?? null;
  const phone = useMediaQuery(PHONE);
  const scopeNode = sessionTotals ? (
    <fieldset className="flex gap-2">
      <legend className="sr-only">Totals for</legend>
      {(['device', 'session'] as const).map((value) => (
        <Button
          key={value}
          variant={scope === value ? 'primary' : 'secondary'}
          aria-pressed={scope === value}
          className={phone ? 'min-h-14 pointer-coarse:min-h-14' : ''}
          onClick={() => setScope(value)}
        >
          {value === 'device' ? 'This device' : 'This session'}
        </Button>
      ))}
    </fieldset>
  ) : null;
  const offlineNode = offline ? (
    <div ref={toQueue} className="scroll-mt-4">
      <OfflineStatus
        offline={offline.state}
        queue={offline.queue}
        {...(timeZone ? { timeZone } : {})}
        {...(offline.rows ? { rows: offline.rows } : {})}
        onSync={offline.onSync}
      />
    </div>
  ) : null;
  const errorNode = query.isError ? (
    <ErrorState error={query.error} onRetry={() => query.refetch()} />
  ) : null;
  if (phone && open)
    return (
      <ShiftTray
        ending={ending}
        since={since}
        summary={summary}
        timeZone={timeZone}
        counts={counts ?? null}
        pending={pending}
        scope={scopeNode}
        offline={offlineNode}
        error={errorNode}
        onClose={onClose}
        onEnd={onEnd}
        {...(onEnding ? { onEnding } : {})}
      />
    );
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
          <p className="text-sm text-fg-muted">Since {formatTime(since, timeZone ?? undefined)}</p>
          {scopeNode}
          {offlineNode}
          {errorNode}
          {summary ? <Totals summary={summary} timeZone={timeZone} /> : null}
          {ending ? (
            <>
              {summary ? <Handover summary={summary} timeZone={timeZone} /> : null}
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
