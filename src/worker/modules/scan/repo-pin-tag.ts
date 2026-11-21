import { type Grant, grant } from '../../platform/authority.ts';
import { exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ScannerRow, scannerEpochsOf } from './repo-device.ts';
import { STAFF_CODES } from './staff-statements.ts';

type Db = D1Database;

/** The person's tag and reset flag, org-scoped. */
export const pinTagStateStatement = (db: Db, orgId: string, id: string) =>
  stmt(db, 'SELECT pin_tag, pin_reset_required FROM scan_staff WHERE id = ? AND org_id = ?', [
    id,
    orgId,
  ]);

/** The active person who has this tag. */
export const staffWithTagStatement = (db: Db, orgId: string, tag: string) =>
  stmt(db, 'SELECT id FROM scan_staff WHERE org_id = ? AND pin_tag = ? AND disabled_at IS NULL', [
    orgId,
    tag,
  ]);

/**
 * A grant of the paired scanner for the bookkeeping of a PIN it saw: the tag and the reset flag are
 * volatile columns, so no epoch moves and no role, PIN hash or disabled time can change with them.
 */
export const pinStateGrant = (ctx: ServiceContext, scanner: ScannerRow): Grant =>
  grant(ctx, {
    purpose: 'org_mode.scan.staff.pin_state',
    principal: {
      kind: 'scanner',
      scannerId: scanner.id,
      credentialEpoch: scannerEpochsOf(scanner).credential,
    },
    checks: [exactlyOne('scanners', { id: scanner.id, revoked_at: null }, undefined, 'config')],
    target: scanner.id,
    codes: STAFF_CODES,
  });

/** Fills a tag that is not set yet; a tag some other active person has is a unique error on commit. */
export const fillPinTag = (g: Grant, id: string, tag: string) =>
  g.update('scan_staff', {
    set: { pin_tag: tag },
    where: { id, pin_tag: null, disabled_at: null },
  });

/** Sign-in is refused until an admin resets the PIN (which clears the flag). */
export const flagPinReset = (g: Grant, id: string) =>
  g.update('scan_staff', { set: { pin_reset_required: 1 }, where: { id } });

/**
 * The signed-in person's own new PIN, while a reset is required. It moves with the epoch they were
 * read at, so a PIN an admin reset in between is not overwritten.
 */
export async function setOwnPinGrant(
  ctx: ServiceContext,
  scanner: ScannerRow,
  staff: { id: string; authEpoch: number },
  change: { pinHash: string; pinTag: string; macVersion: number; now: number },
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org_mode.scan.staff.pin_self',
    principal: {
      kind: 'scanner',
      scannerId: scanner.id,
      credentialEpoch: scannerEpochsOf(scanner).credential,
    },
    checks: [
      exactlyOne('scanners', { id: scanner.id, revoked_at: null }, undefined, 'config'),
      rowIs(
        'scan_staff',
        staff.id,
        { auth_epoch: staff.authEpoch, disabled_at: null, pin_reset_required: 1 },
        'config',
      ),
    ],
    target: staff.id,
    codes: STAFF_CODES,
  });
  g.update('scan_staff', {
    set: {
      pin_hash: change.pinHash,
      pin_tag: change.pinTag,
      pin_mac_version: change.macVersion,
      pin_set_at: change.now,
      pin_reset_required: 0,
      updated_at: maxNow(change.now),
    },
    where: { id: staff.id },
    require: 'one',
  });
  await g.commit();
}
