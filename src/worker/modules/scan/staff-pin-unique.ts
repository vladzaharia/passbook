import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { fullRosterStatement } from './repo-staff.ts';
import { pinMatcher } from './staff-pin-hash.ts';
import { pinStaffListFromResult } from './staff-pin-snapshot.ts';

/** Whether any member of the org, disabled included, has this PIN (or `ownHash` does). */
export async function pinInUse(
  ctx: ServiceContext,
  orgId: string,
  pin: string,
  ownId: string,
  ownHash?: string,
): Promise<boolean> {
  const roster = pinStaffListFromResult(await fullRosterStatement(ctx.env.DB, orgId).run());
  const matches = await pinMatcher(ctx.env);
  if (ownHash !== undefined && (await matches(ctx.env, ownId, pin, ownHash))) return true;
  for (const person of roster)
    if (await matches(ctx.env, person.id, pin, person.pinHash)) return true;
  return false;
}

/**
 * A fresh 6-digit PIN that no member of the org has, disabled members included (re-enabling one
 * must not bring back a duplicate), and not `ownHash`'s, so a reset always changes it. Signing in
 * with a PIN alone then finds one person. Two requests racing can still make the same PIN; the
 * sign-in then answers as a wrong PIN and the person picks their name. Existing shared PINs stay
 * until reset; sign-in audits them when someone types one.
 */
export async function newUniquePin(
  ctx: ServiceContext,
  orgId: string,
  id: string,
  ownHash?: string,
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const pin = ctx.ids.code(6);
    if (!(await pinInUse(ctx, orgId, pin, id, ownHash))) return pin;
  }
  throw new UnavailableError('Could not generate a new PIN. Try again.', 'PIN_GENERATION_FAILED');
}
