import { run } from '../../platform/db.ts';

export function setPhotoGroup(db: D1Database, passId: string, group: string) {
  return run(db, 'UPDATE passes SET external_id = ? WHERE id = ?', [group, passId]);
}

export function insertRetiredLookupRef(
  db: D1Database,
  transferId: string,
  ref: string,
  retiredAt: number,
) {
  return run(
    db,
    `INSERT INTO pass_credential_tombstones
    (pass_id,org_id,mode,credential_generation,credential_kind,credential_hash,retired_at)
    SELECT pass_id,org_id,mode,source_generation,'lookup',?,? FROM pass_credential_transfers WHERE id=?`,
    [ref, retiredAt, transferId],
  );
}
