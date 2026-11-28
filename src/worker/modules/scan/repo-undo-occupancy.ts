// Undo of a scan at a tracked zone (SA §20.8): every row its group wrote goes back together, or none.
import type { Grant } from '../../platform/authority.ts';
import { stmt } from '../../platform/db.ts';
import type { OccupancyRow } from './occupancy/repo.ts';
import { groupRowsRead } from './occupancy/repo-reads.ts';
import { addUndo } from './occupancy/service.ts';
import { RACE_SCAN_UNDO } from './race-tags.ts';
import { occZonesOf, orgZonesStmt } from './repo-access.ts';
import { orgTimeZoneOf, orgTimeZoneStmt } from './repo-org-clock.ts';
import type { OccupancyUndo, UndoCommit } from './repo-undo-types.ts';

/** A scan's group: itself, and every scan that shares its `group_id` (an override's forced exit). */
export const undoGroupStmt = (db: D1Database, orgId: string, scanId: string) =>
  stmt(
    db,
    `SELECT m.id, m.at FROM scans q JOIN scans m ON m.org_id = q.org_id AND m.mode = q.mode
       AND m.pass_id = q.pass_id
       AND (m.id = q.id OR (q.group_id IS NOT NULL AND m.group_id = q.group_id AND m.outcome = 'ok'))
     WHERE q.id = ? AND q.org_id = ? ORDER BY m.at, m.id`,
    [scanId, orgId],
  );

/** One trip: the rows the group still holds, and the zones their due times come from. */
export async function readOccupancyUndo(
  db: D1Database,
  orgId: string,
  passId: string,
  group: readonly { id: string; at: number }[],
): Promise<OccupancyUndo> {
  const ids = group.map((m) => m.id);
  const read = groupRowsRead(orgId, passId, ids);
  const [rows, zones, clock] = await db.batch([
    stmt(db, read.sql, [...read.params]),
    orgZonesStmt(db, orgId),
    orgTimeZoneStmt(db, orgId),
  ]);
  return {
    group: ids,
    scannedAt: Math.max(...group.map((m) => m.at)),
    rows: (rows?.results ?? []) as unknown as OccupancyRow[],
    zones: occZonesOf(zones),
    orgTimeZone: orgTimeZoneOf(clock),
  };
}

/**
 * The group's rows back (`addUndo`: all or nothing, revisions up), and the group's other scans undone
 * with the target. Clear at runs on the zone's clock, else the org's.
 */
export function addOccupancyUndo(g: Grant, c: UndoCommit, o: OccupancyUndo): void {
  const now = c.ctx.clock.now();
  for (const id of o.group)
    if (id !== c.target.id)
      g.update('scans', {
        tag: RACE_SCAN_UNDO,
        set: { undone_by: c.id, undone_at: now },
        where: { id, pass_id: c.target.passId, undone_by: null, state: 'done', outcome: 'ok' },
        require: 'one',
        returning: ['id'],
      });
  addUndo(g, { passId: c.target.passId, ...o });
}
