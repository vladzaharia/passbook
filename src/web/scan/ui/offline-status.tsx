import { Check, CloudUpload, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { formatCount, formatTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import { OperationRow } from '../../ui/operation/index.ts';
import { useNow } from '../../ui/rel-time.tsx';
import type { ScanState } from '../machine/types.ts';
import type { QueueView } from '../offline/queue-view.ts';
import { useOfflineOperations } from './offline-operations.ts';

const Q = SCAN_HANDHELD_COPY.queue;

/** One saved read: when, how and the door's call. Not confirmed until the server answers its key. */
function QueueRows({ rows, timeZone }: { rows: QueueView[]; timeZone?: string | undefined }) {
  return (
    <ul className="flex flex-col gap-1" aria-label={Q.rows} data-testid="offline-rows">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3 py-1" data-door={r.door}>
          <span
            aria-hidden
            className="grid size-7 flex-none place-items-center rounded-full bg-surface-sunken text-fg-muted"
          >
            {r.door === 'refused' ? (
              <X size={15} strokeWidth={2.5} />
            ) : (
              <Check size={15} strokeWidth={2.5} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{Q.code.replace('{tail}', r.tail)}</span>
            <span className="block text-sm text-fg-muted">
              {formatTime(r.at, timeZone)} · {Q.method[r.method]}
            </span>
          </span>
          <span className="flex-none text-sm font-medium text-fg-muted">
            {r.door === 'refused'
              ? Q.turnedAway
              : r.door === 'unverified'
                ? Q.byStaff
                : Q.notConfirmed}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What the door does with no connection, what is waiting to sync and what did not hold. */
export function OfflineStatus({
  offline,
  queue,
  timeZone,
  onSync,
  rows,
}: {
  /** The saved reads, through the offline read helper; the list is left out without it. */
  rows?: () => Promise<QueueView[]>;
  offline: ScanState['offline'];
  queue: ScanState['queue'];
  timeZone?: string;
  onSync: () => void;
}) {
  const [saved, setSaved] = useState<QueueView[]>([]);
  const waiting = queue.pending;
  const ops = useOfflineOperations(offline, timeZone);
  const now = useNow(1000, offline.syncing);
  useEffect(() => {
    let live = true;
    if (rows && waiting >= 0)
      rows().then(
        (list) => live && setSaved(list),
        () => live && setSaved([]),
      );
    return () => {
      live = false;
    };
  }, [rows, waiting]);
  if (offline.mode === 'stop' && queue.pending === 0 && queue.conflicts === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Offline" data-testid="offline-status">
      <h3 className="text-sm font-semibold text-fg-muted">Offline</h3>
      {offline.mode === 'list' ? (
        <OperationRow operation={ops.list} now={now} elapsed={false} />
      ) : null}
      {offline.mode === 'decide' ? <p>Offline: staff decide each entry.</p> : null}
      {queue.pending > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p role="status">{formatCount(queue.pending)} waiting to sync</p>
          <Button
            variant="secondary"
            className="min-h-14 pointer-coarse:min-h-14"
            onClick={onSync}
            disabled={offline.syncing}
          >
            <CloudUpload aria-hidden size={16} />
            {offline.syncing ? 'Syncing' : 'Sync now'}
          </Button>
        </div>
      ) : null}
      {offline.syncing ? <OperationRow operation={ops.sync} now={now} /> : null}
      {saved.length > 0 ? <QueueRows rows={saved} timeZone={timeZone} /> : null}
      {queue.conflicts > 0 ? (
        <p role="status" data-testid="offline-conflicts">
          {formatCount(queue.conflicts)} {queue.conflicts === 1 ? 'entry was' : 'entries were'} let
          in at the door and refused on sync.
        </p>
      ) : null}
    </section>
  );
}
