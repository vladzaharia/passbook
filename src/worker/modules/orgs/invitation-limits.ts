import { bump } from '../../platform/counters.ts';
import { first } from '../../platform/db.ts';
import { ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const ACTOR_HOURLY_INVITES = 30;
export const ORG_DAILY_INVITES = 100;

/** One pending invitation per address per org, and a ceiling on how many mails a manager can start. */
export async function checkInviteAllowed(
  ctx: ServiceContext,
  input: { actorId: string; orgId: string; email: string },
): Promise<void> {
  const now = ctx.clock.now();
  const pending = await first<{ found: number }>(
    ctx.env.DB,
    `SELECT 1 AS found FROM org_invitations
     WHERE org_id = ? AND email = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?`,
    [input.orgId, input.email, now],
  );
  if (pending)
    throw new ConflictError(
      'This address already has a pending invitation. Revoke it to send a new one.',
      'INVITATION_PENDING',
    );
  const byActor = await bump(ctx.env.DB, `invite:actor:${input.actorId}`, now - (now % HOUR));
  const byOrg = await bump(ctx.env.DB, `invite:org:${input.orgId}`, now - (now % DAY));
  if (byActor > ACTOR_HOURLY_INVITES || byOrg > ORG_DAILY_INVITES) {
    ctx.log.warn('org_invitation.rate_limited', {
      orgId: input.orgId,
      code: 'INVITE_RATE_LIMITED',
    });
    throw new RateLimitedError(3600);
  }
}
