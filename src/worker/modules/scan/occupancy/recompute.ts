// A zone save that moves Max stay, Clear at or the clock recomputes the due time of the passes inside (SA §20.8).
import type { Grant } from '../../../platform/authority.ts';
import { effectiveTimeZone, indexZones } from '../zones-tree.ts';
import { setDue } from './repo.ts';
import { movableRows } from './repo-reads.ts';
import { dueAt, type OccZone, zonePlace } from './rules.ts';

/** Rows moved per save. Past it the cron's re-read still keeps a too-early due time from acting. */
export const RECOMPUTE_BATCH = 100;
const CANDIDATES = 500;

/** Add the due-time updates for the live in rows of `zoneIds`, judged on the zones as saved. Returns how many. */
export async function addDueRecompute(
  g: Grant,
  db: D1Database,
  orgId: string,
  zones: readonly OccZone[],
  zoneIds: readonly string[],
  now: number,
  orgTimeZone: string | null,
): Promise<number> {
  const places = zoneIds.map(zonePlace);
  const rows = await movableRows(db, orgId, places, now, CANDIDATES);
  const index = indexZones(zones);
  let n = 0;
  for (const row of rows) {
    if (n >= RECOMPUTE_BATCH) break;
    const zone = zones.find((z) => zonePlace(z.id) === row.scope);
    if (!zone) continue;
    const due = dueAt(zone, row.entered_at, effectiveTimeZone(index, zone.id, orgTimeZone));
    if (due === row.due_at) continue;
    setDue(g, { passId: row.pass_id, place: row.scope, lastScanId: row.last_scan_id }, due);
    n++;
  }
  return n;
}
