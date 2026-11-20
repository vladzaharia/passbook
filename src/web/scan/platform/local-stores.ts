import { openScanDb } from '../offline/db.ts';
import { createIdbUnsureStore, createMemoryUnsureStore } from '../offline/unsure-store.ts';
import { createIdbKeyValue, createMemoryKeyValue, type LocalStores } from '../offline/wipe.ts';

/** IndexedDB, or memory with a notice when storage is blocked. */
export async function openLocalStores(
  notice: (text: string) => void,
): Promise<{ db: IDBDatabase | null; unsure: LocalStores['unsure']; stores: LocalStores }> {
  let db: IDBDatabase | null = null;
  let unsure: LocalStores['unsure'] = createMemoryUnsureStore();
  try {
    db = await openScanDb();
    unsure = createIdbUnsureStore(db);
  } catch {
    notice('Storage unavailable. Keep this page open until all scans are confirmed.');
  }
  return {
    db,
    unsure,
    stores: {
      unsure,
      queue: db ? createIdbKeyValue(db, 'queue') : createMemoryKeyValue(),
      roster: db ? createIdbKeyValue(db, 'roster') : createMemoryKeyValue(),
      meta: db ? createIdbKeyValue(db, 'meta') : createMemoryKeyValue(),
    },
  };
}
