/**
 * The device's copy of the session's offline list: hashes with a status and a state, no names.
 * It is downloaded whole, then topped up by what changed. A failed download leaves the old list.
 */
import type { z } from 'zod';
import type { ScanRosterSchema } from '../../../shared/contracts/scan-session.ts';
import type { KeyValue } from './wipe.ts';

type Page = z.infer<typeof ScanRosterSchema>;

/** `day` marks an `in` that holds for one venue day; `inDay` is the day it was marked. */
export type RosterEntry = Pick<Page['entries'][number], 'status' | 'state' | 'day'> & {
  inDay?: string;
  /** The other hashes of the same pass: admitting one admits all. */
  sib?: string[];
};

/** The window of the last download, with the server's signature of it, which `batch` echoes. */
export interface RosterMeta {
  asOf: number;
  validUntil: number;
  sig: string;
  /** The session and config revision the list was cut for; another one makes it stale at once. */
  scopeKey: string;
  /** When the whole list was last downloaded; deltas in between are topped up. */
  fullAt: number;
}

export interface RosterApi {
  roster(cursor: string | undefined, since: number | undefined): Promise<Page>;
}

/** A full download this often, so a change a delta missed does not outlive it. */
export const FULL_EVERY_MS = 10 * 60 * 1000;
/** A delta reaches back this far before the last download's `asOf`. */
const OVERLAP_MS = 60 * 1000;
const META = 'roster';

export interface RosterStore {
  meta(): Promise<RosterMeta | null>;
  /** The entry of the first hash that is on the list. */
  find(hashes: readonly string[]): Promise<RosterEntry | null>;
  /** The door let this hash in: the next read of it is a repeat. */
  markIn(hash: string, day: string): Promise<void>;
  refresh(
    api: RosterApi,
    now: number,
    scopeKey: string,
    dayOf: (t: number) => string,
  ): Promise<void>;
}

export function createRosterStore(
  rows: KeyValue<RosterEntry>,
  meta: KeyValue<RosterMeta>,
): RosterStore {
  return {
    meta: async () => (await meta.get(META)) ?? null,
    async find(hashes) {
      for (const h of hashes) {
        const entry = await rows.get(h);
        if (entry) return entry;
      }
      return null;
    },
    async markIn(hash, day) {
      const entry = await rows.get(hash);
      if (!entry) return;
      for (const h of [hash, ...(entry.sib ?? [])]) {
        const e = await rows.get(h);
        if (e) await rows.set(h, { ...e, state: 'in', inDay: day });
      }
    },
    async refresh(api, now, scopeKey, dayOf) {
      const before = await meta.get(META);
      const delta =
        before !== undefined && before.scopeKey === scopeKey && now - before.fullAt < FULL_EVERY_MS;
      const since = delta ? Math.max(0, before.asOf - OVERLAP_MS) : undefined;
      const fetched: (readonly [string, RosterEntry])[] = [];
      let first: Page | null = null;
      let cursor: string | undefined;
      do {
        const page = await api.roster(cursor, since);
        first ??= page;
        const group = new Map<string, string[]>();
        for (const e of page.entries) if (e.g) group.set(e.g, [...(group.get(e.g) ?? []), e.h]);
        for (const e of page.entries)
          fetched.push([
            e.h,
            {
              status: e.status,
              state: e.state,
              ...(e.day ? { day: true } : {}),
              ...(e.state === 'in' ? { inDay: dayOf(page.asOf) } : {}),
              ...(e.g ? { sib: (group.get(e.g) ?? []).filter((h) => h !== e.h) } : {}),
            },
          ]);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      if (!first?.sig) return;
      if (!delta) await rows.clear();
      await rows.setMany(fetched);
      await meta.set(META, {
        asOf: first.asOf,
        validUntil: first.validUntil,
        sig: first.sig,
        scopeKey,
        fullAt: delta && before ? before.fullAt : first.asOf,
      });
    },
  };
}
