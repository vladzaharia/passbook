import type { ServiceContext } from '../../platform/service-context.ts';
import { type MoveRow, setState } from './repo-identity-move.ts';
import type { Pass } from './repo-map.ts';
import { getPass } from './repo-read-pass.ts';
import { setPassStatus } from './service-status.ts';

export const SYSTEM = { type: 'system', id: null } as const;

export const gone = (p: Pass | null): boolean =>
  p?.status !== 'active' || p.removedAt !== null || p.deletedAt !== null;

/**
 * The old pass was voided, removed or deleted by someone: its replacement goes with it, so a revoked credential
 * never lives on, and the row stops (no timer, no reminder). One step each: a rerun finds the replacement gone
 * and only closes the row.
 */
export async function revokeReplacement(
  ctx: ServiceContext,
  row: MoveRow,
  reason = 'old_revoked',
): Promise<void> {
  const made = await getPass(ctx.env.DB, row.new_pass_id, row.org_id);
  if (made && !gone(made))
    await setPassStatus(ctx, SYSTEM, made.id, 'voided', row.org_id, undefined, {
      source: 'move',
      sourceRef: `revoke:${row.id}`,
    });
  await setState(
    ctx.env.DB,
    row.id,
    ['issued', 'notified', 'registered', 'kept', 'kept_both'],
    { state: 'kept', reason },
    ctx.clock.now(),
  );
  ctx.log.info('identity_move.old_revoked', { moveId: row.id, reason });
}
