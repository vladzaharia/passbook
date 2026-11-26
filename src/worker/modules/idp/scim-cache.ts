import { activeToken, pendingToken, type ScimTokenRow } from './repo-scim-tokens.ts';

/** The two current token rows are cached per isolate. A rotation elsewhere reaches this isolate within this long. */
export const CACHE_MS = 5_000;

export interface Snapshot {
  db: D1Database;
  at: number;
  active: ScimTokenRow | null;
  pending: ScimTokenRow | null;
}
let cache: Snapshot | null = null;

/** Forgets the cached rows: called wherever this isolate activates or retires a token. */
export function dropScimTokenCache(): void {
  cache = null;
}

export async function snapshot(db: D1Database, now: number): Promise<Snapshot> {
  if (cache && cache.db === db && now - cache.at >= 0 && now - cache.at < CACHE_MS) return cache;
  cache = { db, at: now, active: await activeToken(db), pending: await pendingToken(db) };
  return cache;
}
