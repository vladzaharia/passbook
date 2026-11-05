/**
 * IndexedDB `passbook-scan`, version 1 (AC 6.5): about 60 lines of promises and no dependency.
 * Every access goes through a store interface with an in-memory twin, so unit tests never need
 * IndexedDB; this file runs for real in the e2e project (Chromium).
 */

export const DB_NAME = 'passbook-scan';
export const DB_VERSION = 1;

/** Object stores and their key paths. All four exist from version 1 so the version never moves. */
export const STORES = {
  unsure: 'key',
  queue: 'key',
  roster: 'h',
  meta: 'k',
} as const;
export type StoreName = keyof typeof STORES;

const settle = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

export function openScanDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        const store = db.createObjectStore(name, { keyPath });
        if (name === 'queue') store.createIndex('clientTs', 'clientTs');
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
    open.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

/** One object store as a small async collection. */
export function collection<T>(db: IDBDatabase, name: StoreName) {
  const store = (mode: IDBTransactionMode) => db.transaction(name, mode).objectStore(name);
  return {
    put: async (value: T): Promise<void> => void (await settle(store('readwrite').put(value))),
    get: (key: string): Promise<T | undefined> => settle(store('readonly').get(key)),
    all: (): Promise<T[]> => settle(store('readonly').getAll()),
    remove: async (key: string): Promise<void> =>
      void (await settle(store('readwrite').delete(key))),
    clear: async (): Promise<void> => void (await settle(store('readwrite').clear())),
  };
}
