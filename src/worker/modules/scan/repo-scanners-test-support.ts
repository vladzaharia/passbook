import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';

/**
 * Test-only: edits a scanner row directly, bypassing grants, to stage a configuration change that
 * happens "elsewhere". Production edits go through the grant functions in `repo-scanners.ts`.
 */
export function updateScannerStmt(
  db: D1Database,
  id: string,
  patch: {
    name?: string;
    settings?: string;
    eventId?: string | null;
    timeZone?: string;
    mode?: Mode;
  },
  now: number,
): D1PreparedStatement {
  const sets = ['updated_at = MAX(updated_at + 1, ?)'];
  const params: (string | number | null)[] = [now];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.settings !== undefined) {
    sets.push('settings = ?');
    params.push(patch.settings);
  }
  if (patch.eventId !== undefined) {
    sets.push('event_id = ?');
    params.push(patch.eventId);
  }
  if (patch.timeZone !== undefined) {
    sets.push('time_zone = ?');
    params.push(patch.timeZone);
  }
  return stmt(db, `UPDATE scanners SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}
