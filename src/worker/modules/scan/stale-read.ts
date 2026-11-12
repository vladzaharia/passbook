import {
  type AppError,
  ConflictError,
  ForbiddenError,
  UnauthenticatedError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { staffEpochStmt } from './repo-authority-capture.ts';
import { getScanner } from './repo-device.ts';
import { tenantAuthorityCurrent } from './repo-session-read-predicate.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { scannerCredentialLost } from './scanner-credential-lost.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

/** An admin whose session or access ended signs in again; a re-paired or removed managed device is gone. */
async function adminAccessLost(ctx: ServiceContext, actor: ScanActor): Promise<AppError | null> {
  const authority = actor.tenantAuthority;
  if (!authority || !(await tenantAuthorityCurrent(ctx.env.DB, authority, ctx.clock.now())))
    return new UnauthenticatedError();
  const scanner = actor.scanner;
  if (!scanner) return null;
  const fresh = await getScanner(ctx.env.DB, scanner.id);
  return !fresh ||
    fresh.revokedAt !== null ||
    fresh.credentialEpoch !== scanEpochsOf(actor)?.scanner?.credential
    ? new ForbiddenError('You no longer have access.', 'ACTOR_CHANGED')
    : null;
}

/** The device's signed-in staff member is no longer the one the actor was derived with, or timed out. */
async function staffChanged(ctx: ServiceContext, actor: ScanActor): Promise<boolean> {
  const { scanner, staff } = actor;
  if (actor.principal !== 'scanner' || actor.terminal || !scanner || !staff) return false;
  const now = ctx.clock.now();
  const [fresh, row] = await Promise.all([
    getScanner(ctx.env.DB, scanner.id),
    staffEpochStmt(ctx.env.DB, staff.id, actor.orgId).first<{
      disabled_at: number | null;
      auth_epoch: number;
    }>(),
  ]);
  return (
    !fresh ||
    !row ||
    fresh.staffId !== staff.id ||
    fresh.staffSince !== scanner.staffSince ||
    (fresh.staffSeenAt ?? 0) < now - STAFF_IDLE_MS ||
    (fresh.staffSince ?? 0) < now - STAFF_MAX_MS ||
    row.disabled_at !== null ||
    row.auth_epoch !== scanEpochsOf(actor)?.staff?.auth
  );
}

/**
 * Why a device read was refused. Only a lost credential (revoked, expired, replaced token or CSRF
 * secret) unpairs; a staff change asks for the PIN again; anything else is configuration to reload.
 */
export async function staleScanRead(ctx: ServiceContext, actor: ScanActor): Promise<AppError> {
  if (actor.principal === 'admin') {
    const lost = await adminAccessLost(ctx, actor);
    if (lost) return lost;
  } else if (await scannerCredentialLost(ctx, actor))
    return new UnauthenticatedError('Pair this device again.', 'SCANNER_REPAIR');
  if (await staffChanged(ctx, actor))
    return new ConflictError('Staff access changed. Sign in again.', 'SCAN_STAFF_CHANGED');
  return new ConflictError('Configuration changed. Reload and retry.', 'SCAN_CONFIG_CHANGED');
}
