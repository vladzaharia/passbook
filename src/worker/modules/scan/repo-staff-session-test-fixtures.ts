import { first } from '../../platform/db.ts';

export function staffPinHashRow(db: D1Database, staffId: string) {
  return first<{ pin_hash: string }>(db, 'SELECT pin_hash FROM scan_staff WHERE id = ?', [staffId]);
}
