/**
 * Local data goes when the scanner does: on revoke, on unpair, and when the scanner, the mode or
 * the event changes (AC 6.4, SA 2.8).
 */

import type { UnsureStorePort } from '../machine/ports.ts';
import { collection } from './db.ts';

/** The v2 stores (queue, roster) and `meta` as plain key-value collections. */
export interface KeyValue<T = unknown> {
  set(key: string, value: T): Promise<void>;
  get(key: string): Promise<T | undefined>;
  all(): Promise<T[]>;
  clear(): Promise<void>;
}

export function createMemoryKeyValue<T = unknown>(): KeyValue<T> {
  const map = new Map<string, T>();
  return {
    set: async (key, value) => void map.set(key, value),
    get: async (key) => map.get(key),
    all: async () => [...map.values()],
    clear: async () => map.clear(),
  };
}

/** `queue` and `roster` rows carry their key; `meta` rows are `{ k, v }`. */
export function createIdbKeyValue<T>(
  db: IDBDatabase,
  name: 'queue' | 'roster' | 'meta',
): KeyValue<T> {
  const keyPath = name === 'queue' ? 'key' : name === 'roster' ? 'h' : 'k';
  const rows = collection<Record<string, unknown>>(db, name);
  return {
    set: (key, value) => rows.put({ [keyPath]: key, v: value }),
    get: async (key) => ((await rows.get(key)) as { v?: T } | undefined)?.v,
    all: async () => (await rows.all()).map((r) => r.v as T),
    clear: () => rows.clear(),
  };
}

export interface LocalStores {
  unsure: UnsureStorePort;
  queue: KeyValue;
  roster: KeyValue;
  meta: KeyValue;
}

export async function wipeLocal(stores: LocalStores): Promise<void> {
  await Promise.all([
    stores.unsure.clear(),
    stores.queue.clear(),
    stores.roster.clear(),
    stores.meta.clear(),
  ]);
}

export interface ScopeRecord {
  scannerId: string;
  mode: 'live' | 'test';
  eventId: string | null;
}

/** Records the scope on first use; wipes everything when it changed. Returns whether it wiped. */
export async function reconcileScope(stores: LocalStores, scope: ScopeRecord): Promise<boolean> {
  const before = (await stores.meta.get('scope')) as ScopeRecord | undefined;
  const changed =
    before !== undefined &&
    (before.scannerId !== scope.scannerId ||
      before.mode !== scope.mode ||
      before.eventId !== scope.eventId);
  if (changed) await wipeLocal(stores);
  await stores.meta.set('scope', scope);
  return changed;
}

/** Unpair: tell the server (it always answers 204 and clears the cookie), then drop local data. */
export async function unpair(signOut: () => Promise<void>, stores: LocalStores): Promise<void> {
  try {
    await signOut();
  } catch (error) {
    // The credential may already be gone or the network down; the device must still forget.
    void error;
  }
  await wipeLocal(stores);
}
