/**
 * Uploads the queue, oldest first, 50 a request. A row leaves only when the server answered its key,
 * so a dropped connection or a crashed tab costs nothing: the same keys go up again and replay.
 */
import type { z } from 'zod';
import type {
  ScanBatchRequestSchema,
  ScanBatchResultSchema,
} from '../../../shared/contracts/scan-session.ts';
import type { QueueStore } from './queue-store.ts';
import type { RosterMeta } from './roster.ts';

type Request = z.infer<typeof ScanBatchRequestSchema>;
type Result = z.infer<typeof ScanBatchResultSchema>;

export interface BatchApi {
  batch(body: Request): Promise<Result>;
}

export interface SyncResult {
  /** Rows the server answered. */
  done: number;
  /** Of those, reads the door let in and the server did not. */
  conflicts: number;
}

const BATCH = 50;

/** Sends what is queued. Throws on the first failed request, after clearing the rows already answered. */
export async function syncQueue(
  api: BatchApi,
  queue: QueueStore,
  roster: RosterMeta | null,
): Promise<SyncResult> {
  const total: SyncResult = { done: 0, conflicts: 0 };
  const rows = await queue.all();
  for (let at = 0; at < rows.length; at += BATCH) {
    const chunk = rows.slice(at, at + BATCH);
    const result = await api.batch({
      items: chunk.map((r) => ({
        idempotencyKey: r.key,
        code: r.code,
        method: r.method,
        clientTs: r.clientTs,
        door: r.door,
      })),
      ...(roster
        ? { roster: { asOf: roster.asOf, validUntil: roster.validUntil, sig: roster.sig } }
        : {}),
    });
    const answered = new Set(result.items.map((i) => i.idempotencyKey));
    for (const row of chunk) if (answered.has(row.key)) await queue.remove(row.key);
    total.done += answered.size;
    total.conflicts += result.items.filter((i) => i.conflict).length;
  }
  return total;
}
