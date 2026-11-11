import { actorSql, Binds } from '../../platform/authority-principal.ts';
import { authorityPredicate } from '../../platform/authority-read.ts';
import { exactStmt } from '../../platform/db.ts';
import { authorityDenied } from '../../platform/errors.ts';
import type { ScanActor } from './actor.ts';
import { scanPrincipal } from './authority-checks.ts';
import type { UndoPlan } from './undo-authority.ts';

/**
 * A stale undo must not reserve or spend a manager's PIN budget: the actor is live and the target
 * is still the gate's last scan. Config and staff drift are caught at commit, where they refuse
 * without costing a guess.
 */
export function undoApprovalGuard(actor: ScanActor, plan: UndoPlan, now: number) {
  const read = authorityPredicate(scanPrincipal(actor), { scope: 'org_mode', now });
  const { target, gate } = plan;
  return {
    sql: `EXISTS (WITH ${read.ctes} SELECT 1 FROM actor_ok ok
      JOIN scans q ON q.org_id = ok.org_id AND q.mode = ok.mode
      JOIN scan_gates g ON g.org_id = q.org_id AND g.mode = q.mode AND g.pass_id = q.pass_id
        AND g.action_id = q.action_id AND g.last_scan_id = q.id
      WHERE q.id = ? AND q.undone_by IS NULL AND q.state = 'done' AND q.outcome = 'ok'
        AND q.action_kind = 'check_in' AND g.last_at = ?)`,
    params: [...read.params, target.id, gate.last_at],
  };
}

/**
 * Why the guard held back the reservation, from the same actor row the grant reads: a suspended org
 * is 403 `ORG_ACCESS_CHANGED` (never an unpair); a lost actor is 403, or 401 for a scanner.
 * Null when the actor is fine and the target moved.
 */
export async function guardMiss(db: D1Database, actor: ScanActor, now: number) {
  const b = new Binds();
  const row = await exactStmt(
    db,
    `SELECT a.actor_ok, a.org_ok FROM (${actorSql(scanPrincipal(actor), now, b)}) a`,
    b.params,
  ).first<{ actor_ok: number; org_ok: number }>();
  if (row?.org_ok === 0) return authorityDenied('org');
  if (!row || row.actor_ok === 0)
    return authorityDenied('actor', { scanner: actor.principal === 'scanner' });
  return null;
}
