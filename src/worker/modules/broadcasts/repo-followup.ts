import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';

/** The clearing follow-up of each broadcast that has one. */
export const followUpsOf = (
  db: D1Database,
  parentIds: readonly string[],
  orgId: string,
  mode: Mode,
) =>
  parentIds.length === 0
    ? Promise.resolve([] as { id: string; parent_id: string; at: number | null }[])
    : all<{ id: string; parent_id: string; at: number | null }>(
        db,
        `SELECT child.id, child.parent_id, child.at
         FROM broadcasts child JOIN broadcasts parent ON parent.id = child.parent_id
           AND parent.org_id = child.org_id AND parent.mode = child.mode
         WHERE parent.org_id = ? AND parent.mode = ?
           AND child.parent_id IN (SELECT value FROM json_each(?))`,
        [orgId, mode, JSON.stringify(parentIds)],
      );
