import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';
import {
  scanLedgerCommonScopeSql,
  scanLedgerScopeSql,
  scanLedgerSuccessfulCandidateSql,
} from './repo-feed-scope.ts';

type Db = D1Database;

const TYPE_LIMIT = 100;

// A baked template has no org; an org's own never reads another's name.
const TYPE_JOIN = `LEFT JOIN templates t ON t.id = s.template_id AND (t.org_id IS NULL OR t.org_id = s.org_id)`;

/** `todayStmt`, grouped by pass type: the rows sum to that count. */
export const todayByTypeStmt = (
  db: Db,
  actorKey: string,
  orgId: string,
  mode: Mode,
  since: number,
) =>
  stmt(
    db,
    `SELECT s.template_id AS id, t.name AS name, COUNT(*) AS n FROM scans s ${TYPE_JOIN}
     WHERE s.actor_key = ? AND s.org_id = ? AND s.mode = ? AND s.at >= ?
       AND ${scanLedgerScopeSql('s')}
       AND s.outcome = 'ok' AND s.action_kind != 'undo' AND s.undone_by IS NULL
     GROUP BY s.template_id ORDER BY n DESC, t.name LIMIT ${TYPE_LIMIT}`,
    [actorKey, orgId, mode, since],
  );

/** `scanningSessionTodayStmt`, grouped by pass type. */
export const sessionTodayByTypeStmt = (
  db: Db,
  orgId: string,
  sessionId: string,
  mode: Mode,
  since: number,
) =>
  stmt(
    db,
    `WITH session_successes AS MATERIALIZED (
      SELECT s.id FROM scans s
      JOIN scanning_devices d ON d.scanner_id=s.scanner_id AND d.org_id=s.org_id AND d.mode=s.mode
      JOIN scanning_sessions x ON x.id=d.session_id AND x.org_id=d.org_id AND x.mode=d.mode
      JOIN scanners device ON device.id=d.scanner_id AND device.org_id=d.org_id AND device.mode=d.mode
      WHERE x.org_id=? AND x.id=? AND x.mode=?
        AND s.org_id=x.org_id AND s.mode=x.mode AND s.at>=?
        AND s.outcome='ok' AND s.action_kind!='undo' AND s.undone_by IS NULL
        AND ${scanLedgerCommonScopeSql('s')}
    )
    SELECT s.template_id AS id, t.name AS name, count(*) AS n FROM scans s
    JOIN session_successes matching ON matching.id=s.id ${TYPE_JOIN}
    WHERE ${scanLedgerSuccessfulCandidateSql('s')}
    GROUP BY s.template_id ORDER BY n DESC, t.name LIMIT ${TYPE_LIMIT}`,
    [orgId, sessionId, mode, since],
  );
