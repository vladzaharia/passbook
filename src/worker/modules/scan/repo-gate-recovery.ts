import { stmt } from '../../platform/db.ts';

type Db = D1Database;

/** A complete observed gate, including the values needed to undo its last claim. */
export interface GateSnapshot {
  pass_id: string;
  action_id: string;
  scope: string;
  org_id: string;
  mode: string;
  template_id: string;
  kind: string;
  state: string;
  count: number;
  first_at: number;
  last_at: number;
  last_scan_id: string;
  prev_state: string | null;
  prev_last_at: number | null;
  prev_scan_id: string | null;
  previous_scan_state: 'pending' | 'done' | 'failed' | null;
  previous_scan_at: number | null;
}

/** Read gate references even if the interrupted scan never recorded a pass or action. */
export const gatesOfScansStmt = (db: Db, scanIds: string[]): D1PreparedStatement =>
  stmt(
    db,
    `WITH ids AS (SELECT value AS id FROM json_each(?/* scan-ephemeral-scan-id-list */))
     SELECT g.pass_id, g.action_id, g.scope, g.org_id, g.mode, g.template_id, g.kind, g.state, g.count,
       g.first_at, g.last_at, g.last_scan_id, g.prev_state, g.prev_last_at, g.prev_scan_id,
       prior.state AS previous_scan_state, prior.at AS previous_scan_at
     FROM scan_gates g LEFT JOIN scans prior ON prior.id = g.prev_scan_id
     WHERE g.last_scan_id IN (SELECT id FROM ids) OR g.prev_scan_id IN (SELECT id FROM ids)`,
    [JSON.stringify(scanIds)],
  );

/** Quarantine a referenced prior claim even if it is too young for the cron selection. */
export function quarantinePreviousClaimStmt(db: Db, g: GateSnapshot): D1PreparedStatement | null {
  if (
    g.prev_scan_id === null ||
    g.prev_scan_id === g.last_scan_id ||
    g.previous_scan_at === null ||
    (g.previous_scan_state !== 'pending' && g.previous_scan_state !== 'failed')
  )
    return null;
  return stmt(
    db,
    `UPDATE scans SET state = 'failed', reason = 'stale'
    WHERE id = ?/* scan-ephemeral-scan-id */ AND at = ? AND org_id = ? AND mode = ?
      AND (pass_id IS NULL OR pass_id = ?/* scan-ephemeral-pass-id */) AND (action_id IS NULL OR action_id = ?/* scan-ephemeral-action-id */)
      AND (template_id IS NULL OR template_id = ?/* scan-ephemeral-template-id */)
      AND (state = 'pending' OR (state = 'failed' AND reason IS NOT 'stale')) RETURNING id`,
    [g.prev_scan_id, g.previous_scan_at, g.org_id, g.mode, g.pass_id, g.action_id, g.template_id],
  );
}

/**
 * Undo an observed, uncommitted gate only while the entire snapshot and the original pending
 * claim still match. An inconsistent previous snapshot is not safe to undo.
 */
export function releaseObservedGateStmt(
  db: Db,
  g: GateSnapshot,
  claimAt: number,
): D1PreparedStatement | null {
  const inserted =
    g.prev_state === null && g.prev_last_at === null && g.prev_scan_id === null && g.count === 1;
  const updated =
    g.prev_state !== null && g.prev_last_at !== null && g.prev_scan_id !== null && g.count >= 1;
  if (!inserted && !updated) return null;
  const match = `pass_id = ?/* scan-ephemeral-pass-id */ AND action_id = ?/* scan-ephemeral-action-id */ AND scope = ?/* scan-ephemeral-event-scope */ AND org_id = ? AND mode = ?
    AND template_id = ?/* scan-ephemeral-template-id */ AND kind = ? AND state = ? AND count = ? AND first_at = ? AND last_at = ?
    AND last_scan_id = ?/* scan-ephemeral-scan-id */ AND prev_state IS ? AND prev_last_at IS ? AND prev_scan_id IS ?/* scan-ephemeral-scan-id */
    AND EXISTS (SELECT 1 FROM scans q WHERE q.id = ?/* scan-ephemeral-scan-id */ AND q.state = 'pending' AND q.at = ?)`;
  const params = [
    g.pass_id,
    g.action_id,
    g.scope,
    g.org_id,
    g.mode,
    g.template_id,
    g.kind,
    g.state,
    g.count,
    g.first_at,
    g.last_at,
    g.last_scan_id,
    g.prev_state,
    g.prev_last_at,
    g.prev_scan_id,
    g.last_scan_id,
    claimAt,
  ];
  return stmt(
    db,
    inserted
      ? `DELETE FROM scan_gates WHERE ${match}`
      : `UPDATE scan_gates SET state = prev_state, last_at = prev_last_at, last_scan_id = prev_scan_id,
           count = count - 1, prev_state = NULL, prev_last_at = NULL, prev_scan_id = NULL WHERE ${match}
           AND EXISTS (SELECT 1 FROM scans prior WHERE prior.id = scan_gates.prev_scan_id
             AND prior.org_id = scan_gates.org_id AND prior.mode = scan_gates.mode
             AND prior.pass_id = scan_gates.pass_id AND prior.action_id = scan_gates.action_id
             AND prior.template_id = scan_gates.template_id AND prior.state = 'done' AND prior.outcome = 'ok'
             AND prior.undone_by IS NULL
             AND (prior.action_kind = scan_gates.kind OR
               (prior.action_kind = 'undo' AND scan_gates.kind = 'check_in'
                 AND EXISTS (SELECT 1 FROM scans reversed WHERE reversed.id = prior.undoes
                   AND reversed.undone_by = prior.id AND reversed.org_id = prior.org_id
                   AND reversed.mode = prior.mode AND reversed.pass_id = prior.pass_id
                   AND reversed.action_id = prior.action_id))))`,
    params,
  );
}
