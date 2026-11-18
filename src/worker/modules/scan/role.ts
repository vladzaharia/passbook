import type { ScanRoleChange } from '../../../shared/contracts/scan-role.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { ScanDeviceCapabilitiesSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { surfaceFor } from '../../../shared/scan-surfaces.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { kickScreen } from './live.ts';
import { pairedSession } from './pairing-session.ts';
import { scannerEpochsOf } from './repo-device.ts';
import { commitRoleFlip, hasActiveStaff, searchActiveStaff } from './repo-role.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { getStaff } from './repo-staff.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { checkPin } from './staff-pin.ts';

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

/** A phone flips to a Customer screen freely; back to Scanner needs a staff PIN when staff exist. */
export async function changeRole(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanRoleChange,
  csrfToken: string | null,
): Promise<ScanSession> {
  const scanner = flippable(actor);
  const to = input.role;
  let unlockedBy: string | null = null;
  if (to === 'scan' && scanner.deviceRole !== 'scan') {
    if (await hasActiveStaff(ctx.env.DB, actor.orgId)) {
      if (!input.unlock)
        throw new ForbiddenError('Enter a staff PIN to switch back.', 'UNLOCK_REQUIRED');
      const { staffId, pin } = input.unlock;
      const staff = await getStaff(ctx.env.DB, actor.orgId, staffId);
      await checkPin(ctx, { scannerId: scanner.id, orgId: actor.orgId, staffId, staff, pin });
      unlockedBy = staffId;
    }
  }
  if (scanner.deviceRole !== to) {
    const device = await scanningDeviceRow(ctx.env.DB, actor.orgId, scanner.id);
    const caps = device?.capabilities
      ? ScanDeviceCapabilitiesSchema.parse(JSON.parse(device.capabilities))
      : null;
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
        unlockedBy,
      });
    } catch (error) {
      throw await scannerRefusal(ctx, actor, error);
    }
    await kickScreen(ctx, actor.orgId, actor.mode, scanner.id);
  }
  return pairedSession(ctx, scanner.id, csrfToken);
}

/** The pick list for Back to scanning: only a flipped phone asks, and a short name finds no one. */
export async function unlockRoster(ctx: ServiceContext, actor: ScanActor, q: string) {
  const scanner = flippable(actor);
  if (scanner.deviceRole !== 'customer' || q.length < 2) return { items: [] };
  return { items: await searchActiveStaff(ctx.env.DB, actor.orgId, q) };
}
