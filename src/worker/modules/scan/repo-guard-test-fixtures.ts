import { run } from '../../platform/db.ts';

export function revokeScannerForGuard(db: D1Database, scannerId: string, at: number) {
  return run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [at, scannerId]);
}
