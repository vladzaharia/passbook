import { stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import type { GateKey } from './repo-gates.ts';
import type { ScanRow } from './repo-scans.ts';

/** Every write is conditional on the gate still naming the target. D1 batches roll back together. */
export function undoStatements(
  ctx: ServiceContext,
  actor: ScanActor,
  target: ScanRow,
  gate: GateKey,
  id: string,
  key: string,
  approvedBy: string | null,
): D1PreparedStatement[] {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  return [
    stmt(
      db,
      `UPDATE scan_gates SET state = 'undone', count = max(0, count - 1), last_at = ?, last_scan_id = ?,
      prev_state = NULL, prev_last_at = NULL, prev_scan_id = NULL
      WHERE pass_id = ? AND action_id = ? AND scope = ? AND last_scan_id = ?
      AND EXISTS (SELECT 1 FROM scans WHERE id = ? AND undone_by IS NULL)`,
      [now, id, gate.passId, gate.actionId, gate.scope, target.id, target.id],
    ),
    stmt(
      db,
      `UPDATE scans SET undone_by = ?, undone_at = ? WHERE id = ? AND undone_by IS NULL
      AND EXISTS (SELECT 1 FROM scan_gates WHERE pass_id = ? AND action_id = ? AND scope = ? AND last_scan_id = ?)`,
      [id, now, target.id, gate.passId, gate.actionId, gate.scope, id],
    ),
    stmt(
      db,
      `INSERT INTO scans (id, org_id, mode, pass_id, template_id, scanner_id, event_id, actor_type, actor_id,
      actor_key, staff_id, idempotency_key, request_hash, method, state, outcome, action_id, action_kind, undoes, approved_by, at)
      SELECT ?, org_id, mode, pass_id, template_id, ?, event_id, ?, ?, ?, ?, ?, ?, 'manual', 'done', 'ok', action_id, 'undo', id, ?, ?
      FROM scans WHERE id = ? AND undone_by = ?`,
      [
        id,
        actor.scanner?.id,
        actor.actor.type,
        actor.actor.id,
        actor.actorKey,
        actor.staff?.id,
        key,
        `undo:${target.id}`,
        approvedBy,
        now,
        target.id,
        id,
      ],
    ),
    stmt(
      db,
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, actor_type, actor_id, data, at)
      SELECT ?, org_id, pass_id, mode, 'scan.undone', ?, ?, ?, ? FROM scans WHERE id = ? AND undone_by = ?`,
      [
        ctx.ids.ordered(),
        actor.actor.type,
        actor.actor.id,
        JSON.stringify({ scanId: id, undoes: target.id }),
        now,
        target.id,
        id,
      ],
    ),
    stmt(
      db,
      `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, detail)
      SELECT ?, org_id, ?, ?, 'scan.undo', 'scan', id, ?, ? FROM scans WHERE id = ? AND undone_by = ?`,
      [
        now,
        actor.actor.type,
        actor.actor.id,
        ctx.requestId,
        JSON.stringify({ kind: 'check_in' }),
        target.id,
        id,
      ],
    ),
  ];
}
