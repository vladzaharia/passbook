import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';

export interface PhotoMatchRow {
  id: string;
  external_id: string | null;
  serial: string;
}

export function photoMatchRows(
  db: D1Database,
  orgId: string,
  mode: Mode,
  keys: readonly string[],
): Promise<PhotoMatchRow[]> {
  return all<PhotoMatchRow>(
    db,
    `SELECT id, external_id, serial FROM passes
     WHERE org_id = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL AND removed_at IS NULL
       AND (external_id IN (SELECT value FROM json_each(?)) OR serial IN (SELECT value FROM json_each(?)))`,
    [orgId, mode, JSON.stringify(keys), JSON.stringify(keys)],
  );
}
