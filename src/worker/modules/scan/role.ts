import type { ScanRoleChange } from '../../../shared/contracts/scan-role.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { surfaceFor } from '../../../shared/scan-surfaces.ts';
import { readStoredCapabilities } from '../../../shared/stored-capabilities.ts';
import { AppError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { kickScreen } from './live.ts';
import { pairedSession } from './pairing-session.ts';
import { bindStaff, getScanner, scannerEpochsOf } from './repo-device.ts';
import { commitRoleFlip, hasActiveStaff, unlockRosterStatement } from './repo-role.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { loadScanningSession } from './scanning-sessions.ts';
import {
  ANY_MANAGER,
  pinStaffListFromResult,
  preparePinReservation,
  type VerifiedPinSnapshot,
} from './staff-pin.ts';

/**
 * The server holds the role: the caller's claim is never read, only the row the guard resolved.
 * Terminals, display rows and admin sessions have no role to change.
 */
function flippable(actor: ScanActor) {
  const scanner = actor.scanner;
  if (
    actor.principal !== 'scanner' ||
    actor.terminal ||
    !scanner ||
    scanner.kind !== 'device' ||
    (scanner.deviceRole !== 'scan' && scanner.deviceRole !== 'customer')
  )
    throw new ForbiddenError('This device cannot change its role.', 'ROLE_NOT_ALLOWED');
  return scanner;
}

/**
 * A PIN with no name, matched against the org's active staff like the manager code: counted per
 * scanner and per org, never per person. Two people with one PIN answer as a wrong PIN.
 */
async function unlockWithPin(
  ctx: ServiceContext,
  scannerId: string,
  orgId: string,
  pin: string,
): Promise<VerifiedPinSnapshot> {
  const db = ctx.env.DB;
  const roster = await unlockRosterStatement(db, orgId).all();
  const reservation = preparePinReservation(ctx, {
    scannerId,
    orgId,
    staffId: ANY_MANAGER,
    testedManagers: roster.results.length,
  });
  try {
    const results = await db.batch([unlockRosterStatement(db, orgId), ...reservation.stmts]);
    const found = await reservation.verifyAny(
      results.slice(1),
      pinStaffListFromResult(results[0]),
      pin,
      undefined,
      true,
    );
    if (!found) throw new AppError('PIN_INVALID', 400, 'Wrong PIN. Try again later.');
    return found;
  } finally {
    await reservation.refund();
  }
}

/** With staff sign-in on, the person who unlocked is signed in. A refusal leaves the plain sign-in. */
async function signInUnlocker(
  ctx: ServiceContext,
  actor: ScanActor,
  scannerId: string,
  staff: VerifiedPinSnapshot,
): Promise<void> {
  if (!actor.settings.staffSignIn) return;
  const fresh = await getScanner(ctx.env.DB, scannerId);
  if (fresh?.deviceRole !== 'scan') return;
  const device = await scanningDeviceRow(ctx.env.DB, actor.orgId, scannerId);
  const parent = device ? await loadScanningSession(ctx, device.session_id) : null;
  try {
    await bindStaff(
      ctx,
      fresh,
      { id: staff.id, authEpoch: staff.authEpoch },
      parent ? { id: parent.id, configEpoch: parent.config_epoch } : undefined,
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    ctx.log.info('scan.role_signin_skipped', { orgId: actor.orgId, scannerId, code: error.code });
  }
}

/** A phone flips to a Customer screen freely; back to Scanner needs a staff PIN when staff exist. */
export async function changeRole(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanRoleChange,
  csrfToken: string | null,
): Promise<ScanSession> {
  const scanner = flippable(actor);
  const to = input.role;
  let unlocker: VerifiedPinSnapshot | null = null;
  if (
    to === 'scan' &&
    scanner.deviceRole !== 'scan' &&
    (await hasActiveStaff(ctx.env.DB, actor.orgId))
  ) {
    if (!input.unlock)
      throw new ForbiddenError('Enter a staff PIN to switch back.', 'UNLOCK_REQUIRED');
    unlocker = await unlockWithPin(ctx, scanner.id, actor.orgId, input.unlock.pin);
  }
  if (scanner.deviceRole !== to) {
    const device = await scanningDeviceRow(ctx.env.DB, actor.orgId, scanner.id);
    const caps = readStoredCapabilities(device?.capabilities ?? null, (issue) =>
      ctx.log.warn('scan.device_caps_unreadable', { code: 'SCAN_DEVICE_CAPS_UNREADABLE', issue }),
    );
    const surface = to === 'customer' ? 'customer' : surfaceFor('auto', caps);
    const epochs = scannerEpochsOf(scanner);
    try {
      await commitRoleFlip(ctx, {
        scannerId: scanner.id,
        orgId: actor.orgId,
        from: scanner.deviceRole === 'scan' ? 'scan' : 'customer',
        to,
        credentialEpoch: epochs.credential,
        configEpoch: epochs.config,
        device,
        surface,
        unlockedBy: unlocker?.id ?? null,
      });
    } catch (error) {
      throw await scannerRefusal(ctx, actor, error);
    }
    await kickScreen(ctx, actor.orgId, actor.mode, scanner.id);
    if (unlocker) await signInUnlocker(ctx, actor, scanner.id, unlocker);
  }
  return pairedSession(ctx, scanner.id, csrfToken, unlocker !== null);
}
