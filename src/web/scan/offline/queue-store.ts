/**
 * Reads made with no connection, waiting for `POST /batch`. A row is the code, how the door decided
 * and when: never a name or a card. It stays until the server answers that key.
 */
import type { KeyValue } from './wipe.ts';

export interface QueueRow {
  /** The idempotency key the read was made under. */
  key: string;
  scannerId: string;
  code: string;
  method: 'camera' | 'wedge' | 'nfc' | 'manual';
  clientTs: number;
  /** `listed` was on the roster, `unverified` was staff's word, `refused` was turned away. */
  door: 'listed' | 'unverified' | 'refused';
}

export interface QueueStore {
  add(row: QueueRow): Promise<void>;
  remove(key: string): Promise<void>;
  /** Oldest first. */
  all(): Promise<QueueRow[]>;
}

export function createQueueStore(kv: KeyValue<QueueRow>): QueueStore {
  return {
    add: (row) => kv.set(row.key, row),
    remove: (key) => kv.remove(key),
    all: async () => (await kv.all()).sort((a, b) => a.clientTs - b.clientTs),
  };
}

/** What the pending badge counts: saved check-ins. A refusal that syncs is a record, not a scan to wait for. */
export function pendingOf(rows: readonly QueueRow[]): { pending: number; oldestAt: number | null } {
  const waiting = rows.filter((r) => r.door !== 'refused');
  return { pending: waiting.length, oldestAt: waiting[0]?.clientTs ?? null };
}
