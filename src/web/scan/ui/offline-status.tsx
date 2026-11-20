import { CloudUpload } from 'lucide-react';
import { formatCount, formatTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import type { ScanState } from '../machine/types.ts';

/** What the door does with no connection, what is waiting to sync and what did not hold. */
export function OfflineStatus({
  offline,
  queue,
  timeZone,
  onSync,
}: {
  offline: ScanState['offline'];
  queue: ScanState['queue'];
  timeZone?: string;
  onSync: () => void;
}) {
  if (offline.mode === 'stop' && queue.pending === 0 && queue.conflicts === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Offline" data-testid="offline-status">
      <h3 className="text-sm font-semibold text-fg-muted">Offline</h3>
      {offline.mode === 'list' ? (
        <p>
          {offline.listAt === null
            ? 'No offline list yet. Stay online until it loads.'
            : `Offline list from ${formatTime(offline.listAt, timeZone)}`}
        </p>
      ) : null}
      {offline.mode === 'decide' ? <p>Offline: staff decide each entry.</p> : null}
      {queue.pending > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p role="status">{formatCount(queue.pending)} waiting to sync</p>
          <Button variant="secondary" onClick={onSync} disabled={offline.syncing}>
            <CloudUpload aria-hidden size={16} />
            {offline.syncing ? 'Syncing' : 'Sync now'}
          </Button>
        </div>
      ) : null}
      {queue.conflicts > 0 ? (
        <p role="status" data-testid="offline-conflicts">
          {formatCount(queue.conflicts)} {queue.conflicts === 1 ? 'entry was' : 'entries were'} let
          in at the door and refused on sync.
        </p>
      ) : null}
    </section>
  );
}
