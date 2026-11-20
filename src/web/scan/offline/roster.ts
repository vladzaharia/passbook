/**
 * The device's copy of the session's offline list: hashes with a status and a state, no names.
 * It is downloaded whole, then topped up by what changed. A failed download leaves the old list.
 */
import type { z } from 'zod';
import type { ScanRosterSchema } from '../../../shared/contracts/scan-session.ts';
import type { KeyValue } from './wipe.ts';

type Page = z.infer<typeof ScanRosterSchema>;

export type RosterEntry = Pick<Page['entries'][number], 'status' | 'state'>;

/** The window of the last download, with the server's signature of it, which `batch` echoes. */
export interface RosterMeta {
  asOf: number;
  validUntil: number;
  sig: string;
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
  markIn(hash: string): Promise<void>;
  refresh(api: RosterApi, now: number): Promise<void>;
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
    async markIn(hash) {
      const entry = await rows.get(hash);
      if (entry) await rows.set(hash, { ...entry, state: 'in' });
    },
    async refresh(api, now) {
      const before = await meta.get(META);
      const delta = before !== undefined && now - before.fullAt < FULL_EVERY_MS;
      const since = delta ? Math.max(0, before.asOf - OVERLAP_MS) : undefined;
      const fetched: (readonly [string, RosterEntry])[] = [];
      let first: Page | null = null;
      let cursor: string | undefined;
      do {
        const page = await api.roster(cursor, since);
        first ??= page;
        for (const e of page.entries) fetched.push([e.h, { status: e.status, state: e.state }]);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      if (!first?.sig) return;
      if (!delta) await rows.clear();
      await rows.setMany(fetched);
      await meta.set(META, {
        asOf: first.asOf,
        validUntil: first.validUntil,
        sig: first.sig,
        fullAt: delta && before ? before.fullAt : first.asOf,
      });
    },
  };
}
