import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { pinKeysetOrNull } from './keyset-pin.ts';
import { scanIdentify } from './occupancy/inside-identity.ts';
import { livePassIds } from './repo-group.ts';

const GENERIC = new Set(['pass', 'card', 'ticket', 'member']);

/**
 * The person's name when the read gave one: not a title that stands for the pass (its template or plan
 * name, or a generic word), which a template with a fixed display title would otherwise hand us.
 */
export function personName(
  who: { holder: string | null; type: string | null; plan: string | null } | undefined,
) {
  const holder = who?.holder?.trim() ?? '';
  if (!holder) return null;
  const lower = holder.toLowerCase();
  if (
    GENERIC.has(lower) ||
    lower === who?.type?.toLowerCase() ||
    lower === who?.plan?.toLowerCase()
  )
    return null;
  return holder;
}

/** A holder's initials: the first letter of up to two words. */
const initialsOf = (holder: string | null): string =>
  (holder ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join('')
    .toUpperCase();

/**
 * Each pass's initials and whether it is in, the scanned pass first. The name is what this role's
 * card for the pass shows (`scanIdentify`), so a name the card hides is empty here too. A lapsed
 * authority or a failed read leaves the members out: the chip still works without them.
 */
export async function memberInitials(
  ctx: ServiceContext,
  actor: ScanActor,
  scanned: string,
  passIds: readonly string[],
): Promise<NonNullable<ScanOutcome['bundle']>['members'] | null> {
  const order = [scanned, ...passIds.filter((id) => id !== scanned)];
  try {
    const keyset = await pinKeysetOrNull(ctx);
    const named = keyset ? { ...actor, credentialKeysetCommitment: keyset } : actor;
    const [who, live] = await Promise.all([
      scanIdentify(ctx, named, keyset)(order),
      livePassIds(ctx.env.DB, actor, order, ctx.clock.now()),
    ]);
    return order.map((id) => ({
      initials: initialsOf(personName(who.get(id))),
      checkedIn: live.has(id),
    }));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('scan.group.members_unread', { orgId: actor.orgId, code: error.code });
    return null;
  }
}
