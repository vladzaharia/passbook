// GET /scan/live/inside (SA §20.9): Who's in for a Desk-role scanner or a monitor with Desk actions.
import type { ScanWhosInList } from '../../../../shared/contracts/scan-whos-in.ts';
import { ForbiddenError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { policyActor } from '../dto.ts';
import type { ScanActor } from '../guard.ts';
import { pinKeysetOrNull } from '../keyset-pin.ts';
import { scanPolicy } from '../rules.ts';
import { scanIdentify } from './inside-identity.ts';
import { whosInList } from './inside-list.ts';
import { sessionInsideScope } from './inside-scope.ts';

/**
 * Names go to Desk and above, and never to a customer screen, a monitor with Desk actions off, a Door
 * role or a till. Rights come from the signed-in person, not the device (SA D4).
 */
export function admitWhosIn(actor: ScanActor): void {
  const device = actor.scanner?.deviceRole;
  if (device === 'customer' || (device === 'monitor' && !actor.settings.deskActions))
    throw new ForbiddenError('This screen cannot list who is inside.', 'SCREEN_ONLY');
  if (actor.role === null || (device === 'monitor' && !actor.staff))
    throw new ForbiddenError('Sign in to scan.', 'STAFF_REQUIRED');
  if (!scanPolicy(policyActor(actor), { kind: 'mark_out' }).allow)
    throw new ForbiddenError('Only Desk and above can list who is inside.', 'FORBIDDEN');
}

export async function whosIn(
  ctx: ServiceContext,
  actor: ScanActor,
  q: {
    place?: string | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<ScanWhosInList> {
  admitWhosIn(actor);
  const keyset = await pinKeysetOrNull(ctx);
  // The identity checks compare the actor's keyset with each pass's: the live guard leaves it unset.
  const named = keyset ? { ...actor, credentialKeysetCommitment: keyset } : actor;
  return whosInList({
    db: ctx.env.DB,
    orgId: actor.orgId,
    mode: actor.mode,
    scope: await sessionInsideScope(ctx.env.DB, actor),
    ...q,
    now: ctx.clock.now(),
    identify: scanIdentify(ctx, named, keyset),
  });
}
