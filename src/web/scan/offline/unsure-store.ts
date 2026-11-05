/**
 * Persisted "not confirmed yet" scans (AC 6.4). A row holds the code and the action: no holder data.
 * Rows survive a reload for the shift; another scanner's rows never load.
 */

import type { UnsureRow, UnsureStorePort } from '../machine/ports.ts';
import type { Unsure } from '../machine/types.ts';
import { SCAN_TIMING } from '../timing.ts';
import { collection } from './db.ts';

/** How long a row stays: the shift. */
export const SHIFT_MS = 12 * 60 * 60 * 1000;

export function createMemoryUnsureStore(): UnsureStorePort {
  const rows = new Map<string, UnsureRow>();
  return {
    put: async (row) => void rows.set(row.entry.key, row),
    remove: async (key) => void rows.delete(key),
    all: async () => [...rows.values()],
    clear: async () => rows.clear(),
  };
}

export function createIdbUnsureStore(db: IDBDatabase): UnsureStorePort {
  const rows = collection<UnsureRow & { key: string }>(db, 'unsure');
  return {
    put: (row) => rows.put({ ...row, key: row.entry.key }),
    remove: (key) => rows.remove(key),
    all: async () => (await rows.all()).map(({ key: _key, ...row }) => row),
    clear: () => rows.clear(),
  };
}

/**
 * The entries to start the machine with. Rows past the shift and rows of another scanner are
 * deleted; a row past the retry window comes back `expired`, so the recent list can say so.
 */
export async function hydrateUnsure(
  store: UnsureStorePort,
  scannerId: string,
  now: number,
): Promise<Unsure[]> {
  let rows: UnsureRow[];
  try {
    rows = await store.all();
  } catch {
    // Storage blocked or broken: the retry loop still works from memory.
    return [];
  }
  const keep: Unsure[] = [];
  for (const row of rows) {
    const stale = now - row.entry.at > SHIFT_MS;
    if (stale || row.scannerId !== scannerId) {
      await store.remove(row.entry.key).catch(() => undefined);
      continue;
    }
    const expired = now - row.entry.at >= SCAN_TIMING.UNSURE_RETRY_WINDOW;
    keep.push(expired ? { ...row.entry, state: 'expired' } : row.entry);
  }
  return keep;
}
