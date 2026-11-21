import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { activeRosterStatement } from './repo-staff.ts';
import { pinMatches } from './staff-pin-hash.ts';
import { PIN_ONLY_MAX_STAFF } from './staff-pin-only.ts';
import { pinStaffListFromResult } from './staff-pin-snapshot.ts';

/**
 * A fresh 6-digit PIN that no active staff member of the org has (and not `ownHash`'s, so a reset
 * always changes it), so signing in with a PIN alone finds one person. Two requests racing can
 * still make the same PIN; sign-in then asks for a name. Existing shared PINs stay until reset.
 */
export async function newUniquePin(
  ctx: ServiceContext,
  orgId: string,
  id: string,
  ownHash?: string,
): Promise<string> {
  const roster = pinStaffListFromResult(
    await activeRosterStatement(ctx.env.DB, orgId, PIN_ONLY_MAX_STAFF).run(),
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const pin = ctx.ids.code(6);
    let taken = ownHash !== undefined && (await pinMatches(ctx.env, id, pin, ownHash));
    for (const person of roster) {
      if (taken) break;
      taken = await pinMatches(ctx.env, person.id, pin, person.pinHash);
    }
    if (!taken) return pin;
  }
  throw new UnavailableError('Could not generate a new PIN. Try again.', 'PIN_GENERATION_FAILED');
}
