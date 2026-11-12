import { run } from '../../platform/db.ts';

/**
 * A desk display: `updateScanningDevice` folds a `desk` choice into the operator view (role
 * `scan`), which `liveAttachment` refuses. Live fixtures need the monitor role, so set it as a
 * legacy desk device had it, before the actor is built (both writes bump the config epoch).
 */
export async function asDeskDisplay(db: D1Database, scannerId: string): Promise<void> {
  await run(db, "UPDATE scanning_devices SET effective_surface = 'desk' WHERE scanner_id = ?", [
    scannerId,
  ]);
  await run(db, "UPDATE scanners SET device_role = 'monitor' WHERE id = ?", [scannerId]);
}
