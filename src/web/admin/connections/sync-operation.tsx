import type { z } from 'zod';
import type { SyncNowResponseSchema } from '@/shared/contracts/connections.ts';
import { toast } from '../../ui/index.ts';
import { syncNote } from '../operations/notes.ts';
import { OperationSlot } from '../operations/operation-slot.tsx';
import { markApplyStarted } from './files/use-apply-watch.ts';

/** Sync now: the operation shows the run. A sync that joined one already open has none, and says so. */
export async function runSync(
  start: () => Promise<z.infer<typeof SyncNowResponseSchema>>,
  connectionId: string,
  show: (operationId: string) => void,
): Promise<void> {
  try {
    const started = await start();
    markApplyStarted(connectionId);
    if (started.operationId) show(started.operationId);
    else toast.success('Already syncing');
  } catch (error) {
    toast.error(error, 'Could not sync');
  }
}

export function SyncOperation({
  orgId,
  startedId,
  onClear,
}: {
  orgId: string;
  startedId: string | null;
  onClear: () => void;
}) {
  return (
    <OperationSlot
      kind="connection.sync"
      orgId={orgId}
      startedId={startedId}
      onClear={onClear}
      doneNote={syncNote}
    />
  );
}
