import { stmt } from '../../platform/db.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';

/** One batch updates the session, every effective device setting and accepted pass scope. */
export function propagateSessionStmts(
  db: D1Database,
  row: ScanningSessionRow,
  templateIds: string[],
  eventId: string | null,
) {
  const where = 'SELECT scanner_id FROM scanning_devices WHERE org_id=? AND session_id=?';
  return [
    stmt(
      db,
      `UPDATE scanners SET settings=json_patch(?,(SELECT overrides FROM scanning_devices d WHERE d.scanner_id=scanners.id)),
      event_id=?,time_zone=?,updated_at=MAX(updated_at+1,?) WHERE org_id=? AND id IN (${where})`,
      [row.settings, eventId, row.time_zone, row.updated_at, row.org_id, row.org_id, row.id],
    ),
    stmt(db, `DELETE FROM scanner_templates WHERE scanner_id IN (${where})`, [row.org_id, row.id]),
    stmt(
      db,
      `INSERT INTO scanner_templates(scanner_id,template_id)
      SELECT d.scanner_id,t.value FROM scanning_devices d,json_each(?) t WHERE d.org_id=? AND d.session_id=?`,
      [JSON.stringify(templateIds), row.org_id, row.id],
    ),
  ];
}
