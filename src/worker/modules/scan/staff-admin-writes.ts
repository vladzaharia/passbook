import type { z } from 'zod';
import type { UpdateScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { macKeyVersion } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { adminActorOf, adminGrant, audited } from './repo-admin-grant.ts';
import { clearNamedDayStatement } from './repo-pin-tag.ts';
import {
  addStaffPinRotate,
  addStaffUpdate,
  addUnbindStaffEverywhere,
  type ScanStaffRow,
} from './repo-staff.ts';
import { hashPin } from './staff-pin.ts';
import { pinTag } from './staff-pin-hash.ts';
import { newUniquePin } from './staff-pin-unique.ts';
import { STAFF_CODES, staffMutationError } from './staff-statements.ts';

type UpdateStaff = z.infer<typeof UpdateScanStaffSchema>;

/** The grant and commit of a staff edit, for a console session or a key (`actorId` is the user or key id). */
export async function commitStaffUpdate(
  ctx: ServiceContext,
  actorId: string,
  authority: TenantPassWrite,
  observed: ScanStaffRow,
  input: UpdateStaff,
  ip: string | null = null,
): Promise<void> {
  const { orgId, id } = observed;
  const now = ctx.clock.now();
  const action =
    input.disabled === true
      ? 'scan_staff.disable'
      : input.disabled === false
        ? 'scan_staff.enable'
        : 'scan_staff.update';
  const g = adminGrant(
    ctx,
    'org.scan.staff.update',
    actorId,
    authority,
    orgId,
    [],
    STAFF_CODES,
    id,
  );
  addStaffUpdate(g, id, input, now);
  if (input.disabled === true) addUnbindStaffEverywhere(g, id, now);
  g.add(
    audited(g, ctx, {
      orgId,
      ...adminActorOf(authority, actorId, ip),
      action,
      targetType: 'scan_staff',
      targetId: id,
      detail: { fields: Object.keys(input), ...(input.role ? { role: input.role } : {}) },
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    staffMutationError(error);
  }
}

/**
 * The new PIN is returned only here; the stored credential is its staff-specific HMAC. The reset
 * signs the person out of every device in the same batch, so their next scan asks for the new PIN.
 */
export async function commitPinReset(
  ctx: ServiceContext,
  actorId: string,
  authority: TenantPassWrite,
  staff: ScanStaffRow,
  ip: string | null = null,
  committed: () => void = () => {},
): Promise<string> {
  const { orgId, id } = staff;
  // Never the old PIN (under either root mid-rotation), and unique among the org's active staff.
  const pin = await newUniquePin(ctx, orgId, id, staff.pinHash);
  const pinHash = await hashPin(ctx.env, id, pin);
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org.scan.staff.pin_reset',
    actorId,
    authority,
    orgId,
    staff.authEpoch === undefined ? [] : [epochIs('scan_staff', id, 'auth_epoch', staff.authEpoch)],
    STAFF_CODES,
    id,
  );
  addStaffPinRotate(g, id, pinHash, await pinTag(ctx.env, orgId, pin), macKeyVersion(ctx.env), now);
  addUnbindStaffEverywhere(g, id, now);
  g.add(
    audited(g, ctx, {
      orgId,
      ...adminActorOf(authority, actorId, ip),
      action: 'scan_staff.pin_reset',
      targetType: 'scan_staff',
      targetId: id,
      detail: {},
    }),
  );
  await g.commit();
  committed();
  // The person starts the day clean: an admin reset also lifts the daily lock.
  await clearNamedDayStatement(ctx.env.DB, id).run();
  return pin;
}
