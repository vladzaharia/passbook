import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';

/** The staff, session and event rows `captureScanEpochs` reads in one batch with their epochs. */
export const staffEpochStmt = (db: D1Database, staffId: string, orgId: string) =>
  stmt(
    db,
    `SELECT role, disabled_at, pin_hash, auth_epoch FROM scan_staff WHERE id=? AND org_id=?`,
    [staffId, orgId],
  );

export const sessionEpochStmt = (db: D1Database, sessionId: string, orgId: string, mode: Mode) =>
  stmt(
    db,
    `SELECT status, accepts, settings, time_zone, config_epoch FROM scanning_sessions
      WHERE id=? AND org_id=? AND mode=?`,
    [sessionId, orgId, mode],
  );

export const eventEpochStmt = (db: D1Database, eventId: string, orgId: string, mode: Mode) =>
  stmt(
    db,
    `SELECT match_input, match_values, opens_at, closes_at, time_zone, capacity, reentry,
      archived_at, config_epoch,
      (SELECT json_group_array(template_id) FROM
        (SELECT template_id FROM scan_event_templates WHERE event_id=? ORDER BY template_id)) AS tpl
      FROM scan_events WHERE id=? AND org_id=? AND mode=?`,
    [eventId, eventId, orgId, mode],
  );
