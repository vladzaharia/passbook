import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { type ScanReadAuthority, scanRead, scanReadAuthority } from './repo-read-authority.ts';
import { credentialRefChecks } from './repo-scan-checks.ts';
import type { ScanRow } from './repo-scans.ts';

/**
 * A key came again and its claim collides with this request: the actor is still who the guard saw,
 * the credential is unretired, and the colliding claim is the one read. Only then is the collision named.
 */
export async function collidingClaimCurrent(
  ctx: ServiceContext,
  actor: ScanActor,
  refs: readonly string[],
  row: ScanRow,
  idempotencyKey: string,
): Promise<boolean> {
  const auth = scanReadAuthority(actor, {
    now: ctx.clock.now(),
    extraChecks: credentialRefChecks(refs),
  });
  const current = await collidingClaimStmt(
    ctx.env.DB,
    auth,
    actor.actorKey,
    row,
    idempotencyKey,
  ).first<{ authorized: number }>();
  return current?.authorized === 1;
}

export const collidingClaimStmt = (
  db: D1Database,
  auth: ScanReadAuthority,
  actorKey: string,
  row: ScanRow,
  idempotencyKey: string,
) =>
  scanRead(
    db,
    auth,
    `SELECT CASE WHEN ${auth.present} AND EXISTS (SELECT 1 FROM scans existing
        WHERE existing.id = ? AND existing.at = ? AND existing.state = ? AND existing.reason IS ?
          AND existing.actor_key = ? AND existing.idempotency_key = ? AND existing.request_hash = ?
          AND ${auth.tenantOnce('existing', 'scans')}) THEN 1 ELSE 0 END AS authorized
     FROM ${auth.anchor}`,
    [row.id, row.at, row.state, row.reason, actorKey, idempotencyKey, row.requestHash],
  );
