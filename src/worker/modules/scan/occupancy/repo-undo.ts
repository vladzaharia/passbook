// Occupancy undo statements: each row back exactly as it was, or the whole batch refused (`lineage`).
import type { Grant, GrantedStatement } from '../../../platform/authority.ts';
import { exists, type GrantCond, not, tenantSql } from '../../../platform/authority-cond.ts';
import { marks, type OccupancyRow } from './repo.ts';
import type { OccZone } from './rules.ts';

/** The scan inserted this row (no row was there before it): an entry insert sets both times to its clock. */
export const insertedBy = (row: OccupancyRow) =>
  row.prev_state === null && row.prev_seq === null && row.first_at === row.last_entry_at;

/**
 * Undo one row: delete what the scan inserted, else put the previous values back (its sequence too).
 * Every value read is in the where, and `require: 'one'` refuses the batch if any changed.
 */
export function undoRow(g: Grant, row: OccupancyRow, dueAt: number | null): GrantedStatement {
  const key = {
    pass_id: row.pass_id,
    scope: row.scope,
    last_scan_id: row.last_scan_id,
    state: row.state,
    seq: row.seq,
  };
  if (row.prev_state === null)
    return g.delete('scan_presence', {
      where: {
        ...key,
        prev_state: null,
        prev_seq: null,
        first_at: row.first_at,
        last_entry_at: row.last_entry_at,
      },
      require: 'one',
      returning: ['pass_id'],
    });
  return g.update('scan_presence', {
    set: {
      state: row.prev_state,
      tracking: row.prev_tracking,
      entered_at: row.prev_entered_at,
      first_at: row.prev_first_at,
      last_entry_at: row.prev_last_entry_at,
      last_scan_id: row.prev_scan_id,
      due_at: dueAt,
      seq: row.prev_seq ?? 0,
      prev_state: null,
      prev_tracking: null,
      prev_entered_at: null,
      prev_first_at: null,
      prev_last_entry_at: null,
      prev_scan_id: null,
      prev_seq: null,
    },
    where: {
      ...key,
      prev_state: row.prev_state,
      prev_tracking: row.prev_tracking,
      prev_entered_at: row.prev_entered_at,
      prev_first_at: row.prev_first_at,
      prev_last_entry_at: row.prev_last_entry_at,
      prev_scan_id: row.prev_scan_id,
      prev_seq: row.prev_seq,
    },
    require: 'one',
    returning: ['pass_id'],
  });
}

/**
 * The undo still applies whole: the pass still has exactly `count` rows the group wrote, and no other
 * row of the pass at any place was written after them (commit order: `seq`, set inside each write).
 */
export function undoStillApplies(
  passId: string,
  group: readonly string[],
  count: number,
  lastSeq: number,
): GrantCond[] {
  const ids = marks(group.length);
  return [
    not(
      tenantSql(
        `EXISTS (SELECT 1 FROM scan_presence x WHERE x.org_id = {org} AND x.mode = {mode} AND x.pass_id = ?
          AND x.last_scan_id NOT IN (${ids}) AND x.seq > ?)`,
        [passId, ...group, lastSeq],
      ),
    ),
    tenantSql(
      `(SELECT count(*) FROM scan_presence x WHERE x.org_id = {org} AND x.mode = {mode} AND x.pass_id = ?
        AND x.last_scan_id IN (${ids})) = ?`,
      [passId, ...group, count],
    ),
  ];
}

/** A zone a restored in row depends on is unchanged since the undo read it (no Track off, archive or move). */
export const zoneUnchanged = (z: Pick<OccZone, 'id' | 'updatedAt'>): GrantCond =>
  exists('scan_zones', { id: z.id, updated_at: z.updatedAt, archived_at: null });
