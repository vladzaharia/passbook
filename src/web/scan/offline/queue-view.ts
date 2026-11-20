/** What the shift sheet may show of the queue: when, how and the door's call, never a name or the code. */
import type { QueueRow } from './queue-store.ts';

export interface QueueView {
  key: string;
  at: number;
  method: QueueRow['method'];
  door: QueueRow['door'];
  /** The last four characters of the code, enough to tell two rows apart. */
  tail: string;
}

/** Oldest first, as stored. */
export const queueView = (rows: readonly QueueRow[]): QueueView[] =>
  rows.map((r) => ({
    key: r.key,
    at: r.clientTs,
    method: r.method,
    door: r.door,
    tail: r.code.trim().slice(-4).toUpperCase(),
  }));
