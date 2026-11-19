// What a Desk monitor's watch reaches (SA D28): the rows, places and scans of its station, zone or event.
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScanWatchSchema } from '../../../shared/contracts/scan-setups.ts';
import { all, first } from '../../platform/db.ts';
import { orgZoneRows, sessionZoneIds } from './repo-zones.ts';

/** Ids only: org and mode bind every read that uses them. Zones are the watched subtrees. */
export interface WatchCover {
  allOrg: boolean;
  scannerIds: string[];
  sessionIds: string[];
  eventId: string | null;
  zoneIds: string[];
}

interface Scoped {
  orgId: string;
  mode: Mode;
}

export interface CoveredRow {
  scannerId: string | null;
  sessionId?: string | null;
  eventId: string | null;
  zoneId?: string | null;
}

/** The actor's watch when it is a monitor, with each watched zone widened to its subtree; null otherwise. */
export async function loadWatchCover(
  db: D1Database,
  actor: Scoped & { scanner: { id: string; deviceRole: string } | null },
): Promise<WatchCover | null> {
  if (actor.scanner?.deviceRole !== 'monitor') return null;
  const row = await first<{ watch: string | null }>(
    db,
    'SELECT watch FROM scanner_setups WHERE scanner_id = ? AND org_id = ?',
    [actor.scanner.id, actor.orgId],
  );
  if (!row?.watch) return null;
  const parsed = ScanWatchSchema.safeParse(JSON.parse(row.watch));
  if (!parsed.success) return null;
  const w = parsed.data;
  const zones = await orgZoneRows(db, actor.orgId);
  const below = (id: string): string[] => [
    id,
    ...zones.filter((z) => z.parentId === id).flatMap((z) => below(z.id)),
  ];
  return {
    allOrg: w.allOrg,
    scannerIds: w.scannerIds,
    sessionIds: w.sessionIds ?? [],
    eventId: w.eventId ?? null,
    zoneIds: [...new Set((w.zoneIds ?? []).flatMap(below))],
  };
}

export function watchCovers(cover: WatchCover | null | undefined, r: CoveredRow): boolean {
  if (!cover) return false;
  return (
    cover.allOrg ||
    (!!r.scannerId && cover.scannerIds.includes(r.scannerId)) ||
    (!!r.sessionId && cover.sessionIds.includes(r.sessionId)) ||
    (!!r.eventId && r.eventId === cover.eventId) ||
    (!!r.zoneId && cover.zoneIds.includes(r.zoneId))
  );
}

/** `watchCovers` over `scans q`; false when there is no watch. */
export function watchCoversSql(cover: WatchCover | null | undefined): {
  sql: string;
  params: (string | number | null)[];
} {
  if (!cover) return { sql: '0', params: [] };
  const list = (ids: string[]) => JSON.stringify(ids);
  return {
    sql: `(? = 1 OR q.scanner_id IN (SELECT value FROM json_each(?)) OR q.session_id IN (SELECT value FROM json_each(?))
      OR (? IS NOT NULL AND q.event_id = ?) OR q.zone_id IN (SELECT value FROM json_each(?)))`,
    params: [
      cover.allOrg ? 1 : 0,
      list(cover.scannerIds),
      list(cover.sessionIds),
      cover.eventId,
      cover.eventId,
      list(cover.zoneIds),
    ],
  };
}

/** Zone roots a monitor's Who's in starts from: its zones, its sessions' zones and its scanners' sessions' zones. */
export async function watchZoneRoots(
  db: D1Database,
  actor: Scoped,
  cover: WatchCover,
): Promise<string[]> {
  if (cover.allOrg)
    return (await orgZoneRows(db, actor.orgId)).filter((z) => z.parentId === null).map((z) => z.id);
  const viaScanners = cover.scannerIds.length
    ? await all<{ session_id: string }>(
        db,
        `SELECT session_id FROM scanning_devices WHERE org_id = ? AND mode = ?
         AND scanner_id IN (SELECT value FROM json_each(?))`,
        [actor.orgId, actor.mode, JSON.stringify(cover.scannerIds)],
      )
    : [];
  const sessions = new Set([...cover.sessionIds, ...viaScanners.map((r) => r.session_id)]);
  const ids = new Set(cover.zoneIds);
  for (const id of sessions) for (const z of await sessionZoneIds(db, actor.orgId, id)) ids.add(z);
  return [...ids];
}

/** Events of the org and mode that track entries and exits: what an `allOrg` watch covers. */
export const watchedOrgEvents = (db: D1Database, orgId: string, mode: Mode) =>
  all<{ id: string; name: string; capacity: number | null }>(
    db,
    `SELECT id, name, capacity FROM scan_events
     WHERE org_id = ? AND mode = ? AND reentry = 1 AND archived_at IS NULL ORDER BY opens_at DESC, id LIMIT 64`,
    [orgId, mode],
  );
