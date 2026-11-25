import { bump } from '../../platform/counters.ts';
import { ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { pendingForEmail } from './repo.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const ACTOR_HOURLY_DEV_INVITES = 5;
export const ORG_DAILY_DEV_INVITES = 10;

/** One pending invitation per address per org, and a ceiling on how many invitations a person or key starts. */
export async function checkDeveloperInviteAllowed(
  ctx: ServiceContext,
  input: { actorId: string; orgId: string; email: string },
): Promise<void> {
  const now = ctx.clock.now();
  if (await pendingForEmail(ctx.env.DB, input.orgId, input.email, now))
    throw new ConflictError(
      'This address already has a pending developer invitation. Revoke it to send a new one.',
      'DEVELOPER_INVITE_PENDING',
    );
  const byActor = await bump(ctx.env.DB, `devinvite:actor:${input.actorId}`, now - (now % HOUR));
  const byOrg = await bump(ctx.env.DB, `devinvite:org:${input.orgId}`, now - (now % DAY));
  if (byActor > ACTOR_HOURLY_DEV_INVITES || byOrg > ORG_DAILY_DEV_INVITES) {
    ctx.log.warn('developer_invitation.rate_limited', {
      orgId: input.orgId,
      code: 'DEV_INVITE_RATE_LIMITED',
    });
    throw new RateLimitedError(3600);
  }
}
