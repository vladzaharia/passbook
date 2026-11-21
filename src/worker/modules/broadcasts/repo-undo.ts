import type { BroadcastKind } from '../../../shared/contracts/broadcasts.ts';
import { CHANGE_RUN_UNDO_MS } from '../../../shared/contracts/broadcasts-change.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { first, type SqlValue, stmt } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { type BroadcastRow, broadcastAuthority } from './repo.ts';

/** States a change run can be undone from: it has ended and applied something. */
export const UNDOABLE_STATES = ['sent', 'partial', 'failed', 'cancelled'] as const;

/**
 * The undo's own condition, held in the write that creates or restarts it: the run is a change run
 * (not itself an undo) of this org and mode, it has ended, and it ended less than 24 hours ago.
 */
export function undoParentWhere(
  parentId: string,
  orgId: string,
  mode: Mode,
  now: number,
): { sql: string; params: SqlValue[] } {
  return {
    sql: ` AND EXISTS (SELECT 1 FROM broadcasts p WHERE p.id = ? AND p.org_id = ? AND p.mode = ?
      AND p.kind = 'change' AND p.parent_id IS NULL AND p.started_at IS NOT NULL
      AND p.state IN (${UNDOABLE_STATES.map((s) => `'${s}'`).join(', ')}) AND p.finished_at > ?)`,
    params: [parentId, orgId, mode, now - CHANGE_RUN_UNDO_MS],
  };
}

/**
 * A failed undo (its workflow died or its starter was revoked) runs again as the same child, under the
 * new asker's authority and a new workflow instance. Only a child that ended on an error restarts, so a
 * finished or running undo is never started twice.
 */
export function restartUndoStmt(
  db: D1Database,
  child: { id: string; parent_id: string },
  who: { type: string; id: string | null },
  instance: string,
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, now, true);
  const parent = undoParentWhere(child.parent_id, authority.orgId, authority.mode, now);
  return stmt(
    db,
    `UPDATE broadcasts SET state = 'scheduled', at = ?, created_by_type = ?, created_by_id = ?,
       created_at = ?, started_at = NULL, finished_at = NULL, error_code = NULL, stop_at = NULL,
       checked_at = NULL, instance = ?
     WHERE id = ? AND parent_id = ? AND state = 'failed' AND error_code IS NOT NULL
       AND kind = 'change' AND org_id = ? AND mode = ? AND (${guard.sql})${parent.sql}`,
    [
      now,
      who.type,
      who.id,
      now,
      instance,
      child.id,
      child.parent_id,
      authority.orgId,
      authority.mode,
      ...guard.params,
      ...parent.params,
    ],
  );
}

/** Asks a sending run to end after its chunk; only the authorized tenant and mode, only while sending. */
export function stopBroadcastStmt(
  db: D1Database,
  id: string,
  kind: BroadcastKind,
  authority: TenantPassWrite,
  now: number,
): D1PreparedStatement {
  const guard = broadcastAuthority(authority, now, kind === 'change');
  return stmt(
    db,
    `UPDATE broadcasts SET stop_at = COALESCE(stop_at, ?)
     WHERE id = ? AND state = 'sending' AND kind = ? AND org_id = ? AND mode = ? AND (${guard.sql})`,
    [now, id, kind, authority.orgId, authority.mode, ...guard.params],
  );
}

/** The undo of a change run, if one was asked for: one child per run (the unique parent index). */
export const childOf = (db: D1Database, parentId: string, orgId: string, mode: Mode) =>
  first<BroadcastRow>(
    db,
    'SELECT * FROM broadcasts WHERE parent_id = ? AND org_id = ? AND mode = ?',
    [parentId, orgId, mode],
  );
