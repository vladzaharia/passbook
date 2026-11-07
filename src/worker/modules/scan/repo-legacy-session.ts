import { stmt } from '../../platform/db.ts';

export const syncStandaloneSessionStmt = (db: D1Database, orgId: string, id: string, now: number) =>
  stmt(
    db,
    `
  UPDATE scanning_sessions SET
    name=(SELECT name FROM scanners WHERE id=?),
    mode=(SELECT mode FROM scanners WHERE id=?),
    settings=(SELECT settings FROM scanners WHERE id=?),
    time_zone=(SELECT time_zone FROM scanners WHERE id=?),
    accepts=(SELECT CASE WHEN event_id IS NOT NULL THEN json_object('eventId',event_id)
      WHEN EXISTS(SELECT 1 FROM scanner_templates t WHERE t.scanner_id=s.id)
      THEN json_object('templateIds',json((SELECT json_group_array(template_id) FROM scanner_templates t WHERE t.scanner_id=s.id)))
      ELSE NULL END FROM scanners s WHERE s.id=?),
    updated_at=MAX(updated_at+1,?) WHERE org_id=? AND id=?`,
    [id, id, id, id, id, now, orgId, id],
  );
export const syncStandaloneModeStmt = (db: D1Database, orgId: string, id: string, mode: string) =>
  stmt(db, 'UPDATE scanning_devices SET mode=? WHERE org_id=? AND scanner_id=? AND session_id=?', [
    mode,
    orgId,
    id,
    id,
  ]);
