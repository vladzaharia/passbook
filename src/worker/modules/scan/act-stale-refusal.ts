import { type Check, rowIs } from '../../platform/authority-checks.ts';
import { actorSql, Binds } from '../../platform/authority-principal.ts';
import { exactStmt } from '../../platform/db.ts';
import {
  AppError,
  authorityDenied,
  ConflictError,
  UnauthenticatedError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { ScanActor } from './actor.ts';
import { epochsMissing } from './authority-capture.ts';
import { scanActorChecks, scanPrincipal } from './authority-checks.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { scannerCredentialLost } from './scanner-credential-lost.ts';

const SCAN_CODES = { config: 'SCAN_CONFIG_CHANGED', staff: 'SCAN_STAFF_CHANGED' } as const;

/** A claimed attempt lost its authority after the claim; its claim is already released or recorded. */
export class ScanAttemptRaced extends StaleScanAuthority {}

/** The epochs the guard captured, still current: only a change after the guard read moves them. */
function epochChecks(actor: ScanActor): Check[] {
  const epochs = scanEpochsOf(actor);
  if (!epochs) throw epochsMissing();
  const { scanner, staff, session } = epochs;
  return [
    ...(scanner ? [rowIs('scanners', scanner.id, { config_epoch: scanner.config }, 'config')] : []),
    ...(staff ? [rowIs('scan_staff', staff.id, { auth_epoch: staff.auth }, 'staff')] : []),
    ...(session
      ? [rowIs('scanning_sessions', session.id, { config_epoch: session.config }, 'config')]
      : []),
    ...Object.entries(epochs.events).map(([id, epoch]) =>
      rowIs('scan_events', id, { config_epoch: epoch }, 'config'),
    ),
  ];
}

/**
 * Why a scan lost its authority mid-request: a lost credential is 401 (re-pair), staff or
 * configuration drift a 409 the client refetches on, a suspended org or ended admin session 403.
 * Null when the actor is still current. After a claim every check the grant runs held once, so all
 * of them are asked; before it (the request's first fences, a replay) only the captured epochs are,
 * because a scope the guard derived can fail a shape check without anything having moved.
 */
export async function staleActorRefusal(
  ctx: ServiceContext,
  actor: ScanActor,
  claimed: boolean,
): Promise<AppError | null> {
  if (await scannerCredentialLost(ctx, actor))
    return new UnauthenticatedError('Pair this device again.', 'SCANNER_REPAIR');
  const now = ctx.clock.now();
  const checks = claimed ? scanActorChecks(actor, { now }) : epochChecks(actor);
  const b = new Binds();
  const principal = actorSql(scanPrincipal(actor), now, b);
  const columns = checks.map((c, i) => `, COALESCE((${c.ok(b, 'org_mode')}), 0) AS c${i}`);
  const row = await exactStmt(
    ctx.env.DB,
    `WITH actor AS MATERIALIZED (${principal})
     SELECT a.actor_ok, a.org_ok${columns.join('')} FROM actor a`,
    b.params,
  ).first<Record<string, number>>();
  if (row?.org_ok === 0) return authorityDenied('org');
  const failed =
    row?.actor_ok !== 1 ? 'actor' : checks.find((_, i) => row?.[`c${i}`] !== 1)?.reason;
  if (!failed) return null;
  // The credential is not lost (checked above): a scanner refused as `actor` is configuration drift.
  if (failed === 'actor' && actor.principal === 'scanner')
    return new ConflictError('Configuration changed. Reload and retry.', SCAN_CODES.config);
  return authorityDenied(failed, { codes: SCAN_CODES });
}

/** The pass or its gate moved under a current actor: the client retries once with the same key. */
export const passRaced = () =>
  new AppError('SCAN_IN_PROGRESS', 409, 'The pass changed during this scan. Try again.', {
    headers: { 'retry-after': '1' },
  });
