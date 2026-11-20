import type { Mode } from '../../../shared/contracts/common.ts';
import type { PhotoMatch } from '../../../shared/contracts/photo-import.ts';
import { all } from '../../platform/db.ts';

interface Row {
  id: string;
  external_id: string | null;
  serial: string;
}

/**
 * Matches file names to active passes of one org and mode by External ID, then by serial. A name that
 * several passes share on its first matching field is `ambiguous` and gets no photo.
 */
export async function matchPhotoKeys(
  db: D1Database,
  orgId: string,
  mode: Mode,
  keys: readonly string[],
): Promise<PhotoMatch[]> {
  const unique = [...new Set(keys)];
  const rows = await all<Row>(
    db,
    `SELECT id, external_id, serial FROM passes
     WHERE org_id = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL AND removed_at IS NULL
       AND (external_id IN (SELECT value FROM json_each(?)) OR serial IN (SELECT value FROM json_each(?)))`,
    [orgId, mode, JSON.stringify(unique), JSON.stringify(unique)],
  );
  return unique.map((key) => {
    const byExternal = rows.filter((r) => r.external_id === key);
    const found = byExternal.length > 0 ? byExternal : rows.filter((r) => r.serial === key);
    if (found.length > 1) return { key, passId: null, state: 'ambiguous' };
    const [only] = found;
    return only ? { key, passId: only.id, state: 'matched' } : { key, passId: null, state: 'none' };
  });
}
