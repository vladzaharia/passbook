// The cron's memory of stays it could not sign: they wait out a growing delay instead of refilling every batch.
import { readSystemValue, writeSystemValue } from '../../settings/repo.ts';

const KEY = 'scan.occupancy.unsigned';
const BASE_MS = 5 * 60_000;
const MAX_MS = 6 * 3_600_000;
/** The skip list travels as one bound value, so the memory is bounded. */
const MAX_ENTRIES = 500;

export interface Unsigned {
  failures: number;
  retryAt: number;
}
export type UnsignedMap = Map<string, Unsigned>;

export async function readUnsigned(db: D1Database): Promise<UnsignedMap> {
  const raw = await readSystemValue(db, KEY);
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  return new Map(
    entries.filter((e): e is [string, Unsigned] => {
      const v = e[1] as Partial<Unsigned> | null;
      return !!v && Number.isFinite(v.failures) && Number.isFinite(v.retryAt);
    }),
  );
}

export async function writeUnsigned(db: D1Database, m: UnsignedMap, now: number): Promise<void> {
  const keep = [...m]
    .sort((a, b) => b[1].failures - a[1].failures || b[1].retryAt - a[1].retryAt)
    .slice(0, MAX_ENTRIES);
  await writeSystemValue(db, KEY, Object.fromEntries(keep), now);
}

/** Stays still waiting out their delay. */
export const waiting = (m: UnsignedMap, now: number): string[] =>
  [...m].filter(([, u]) => u.retryAt > now).map(([k]) => k);

/** One more failure: the delay doubles from 5 minutes to 6 hours. */
export function failed(m: UnsignedMap, key: string, now: number): number {
  const failures = (m.get(key)?.failures ?? 0) + 1;
  m.set(key, { failures, retryAt: now + Math.min(MAX_MS, BASE_MS * 2 ** (failures - 1)) });
  return failures;
}
