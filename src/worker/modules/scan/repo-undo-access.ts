import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { UndoGate } from './repo-undo-grant.ts';

/**
 * An Access card's gate goes back one step (AX 3.5), only while it still points at the grant: the
 * first grant ever deletes the row; otherwise the row returns to its previous touch, a visit fewer
 * when the grant started one, and the undo's scan id holds it.
 */
export function undoAccessGate(
  g: Grant,
  gate: UndoGate,
  undoId: string,
  where: Record<string, SqlValue>,
): GrantedStatement {
  if (gate.prev_state === null)
    return g.delete('scan_gates', { where, require: 'one', returning: ['last_scan_id'] });
  return g.update('scan_gates', {
    set: {
      state: gate.prev_state,
      count: Math.max(0, gate.count - (gate.visit === 1 ? 1 : 0)),
      last_at: gate.prev_last_at,
      last_scan_id: undoId,
      prev_state: null,
      prev_last_at: null,
      prev_scan_id: null,
    },
    where,
    require: 'one',
    returning: ['last_scan_id'],
  });
}
