import { run } from '../../platform/db.ts';

export async function seedScannerSessions(
  db: D1Database,
  templateId: string,
  attachedScannerId: string,
  freeScannerId: string,
) {
  await run(
    db,
    `INSERT INTO scanning_sessions
      (id, org_id, mode, name, accepts, settings, time_zone, created_at, updated_at)
     SELECT id, org_id, mode, name,
       CASE WHEN event_id IS NULL THEN json_object('templateIds', json_array(?))
         ELSE json_object('eventId', event_id) END,
       settings, time_zone, created_at, updated_at FROM scanners WHERE id IN (?, ?)`,
    [templateId, attachedScannerId, freeScannerId],
  );
  await run(
    db,
    `INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode)
     SELECT id, id, org_id, mode FROM scanners WHERE id IN (?, ?)`,
    [attachedScannerId, freeScannerId],
  );
}
