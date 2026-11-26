import type { OffboardPlan } from '../../../shared/contracts/idp-access.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { revokeApiKey } from '../api-keys/service.ts';
import { endSponsor, liveSponsorOf } from '../dev-access/repo-sponsors.ts';
import { closeSandbox } from '../developer/repo-grants.ts';
import { managerOf } from '../orgs/membership-service.ts';
import { revokeActiveMembership } from '../orgs/repo-member-writes.ts';
import { setUserStatus } from '../users/service.ts';
import { offboardable, offboardPlan } from './offboard-plan.ts';
import { limited, needBinding, replay, startIdpOp } from './ops-start.ts';
import { revokeAllGrants } from './repo-role-grants.ts';
import { orgInfo } from './repo-user-access.ts';

export const offboardTarget = (userId: string) => ({ type: 'user', id: userId });

/** The plan, or the reason the user cannot be offboarded. Reads only. */
async function checked(ctx: ServiceContext, userId: string) {
  needBinding(ctx);
  const { admin } = await offboardable(ctx, userId);
  if (admin)
    throw new ConflictError(
      'Remove them from platform admins in Polaris ID first.',
      'IDP_PLATFORM_ADMIN',
    );
  return offboardPlan(ctx, userId);
}

/**
 * Ends what the plan lists, under the admin's own session: each write is a grant that checks it. Every step is
 * idempotent, so a repeat after a failure finishes what is left.
 */
async function endAccess(
  ctx: ServiceContext,
  auth: SessionAuth,
  plan: OffboardPlan,
): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const orgs = await orgInfo(
    db,
    plan.memberships.map((m) => m.org.id),
  );
  for (const m of plan.memberships) {
    // A suspended org takes no membership principal: the admin session acts, as it did to make the plan.
    const manager =
      orgs.get(m.org.id)?.status === 'suspended'
        ? {
            principal: {
              kind: 'platform' as const,
              userId: auth.userId,
              sessionIdHash: auth.sessionId,
              orgId: m.org.id,
              inactiveOk: true as const,
            },
            checks: [],
          }
        : await managerOf(ctx, auth, m.org.id);
    try {
      await revokeActiveMembership(ctx, manager.principal, manager.checks, m.membershipId, {
        orgId: m.org.id,
        actorType: 'user',
        actorId: auth.userId,
        action: 'org_membership.revoke',
        targetType: 'org_membership',
        targetId: m.membershipId,
        detail: { reason: 'offboard' },
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'LAST_ORG_ADMIN')
        throw new ConflictError(`${m.org.name} needs another org admin first.`, 'LAST_ORG_ADMIN');
      throw error;
    }
  }
  for (const s of plan.sponsorships) {
    const sponsor = await liveSponsorOf(db, s.org.id, plan.userId);
    if (!sponsor) continue;
    const manager = await managerOf(ctx, auth, s.org.id);
    await endSponsor(ctx, manager.principal, manager.checks, sponsor.id, 'removed', {
      orgId: s.org.id,
      actorType: 'user',
      actorId: auth.userId,
      action: 'developer.remove',
      targetType: 'developer_sponsor',
      targetId: sponsor.id,
      detail: { reason: 'offboard' },
    });
  }
  await revokeAllGrants(db, plan.userId, auth.userId, now);
  const platform = {
    kind: 'platform',
    userId: auth.userId,
    sessionId: auth.sessionId,
    amr: auth.amr,
  } as const;
  for (const id of plan.platformKeys) await revokeApiKey(ctx, platform, id);
  if (plan.sandboxOrgId) await closeSandbox(ctx, plan.sandboxOrgId, undefined, 'admin');
  // Disabling revokes every session and marks the user for the drain, which takes the roles away.
  await setUserStatus(ctx, auth.userId, plan.userId, 'disabled', auth.sessionId);
}

/**
 * Offboards a user (design 1 section 4.4). A dry run answers the plan and changes nothing. The real call ends the
 * PassBook side now, then starts the operation that takes the roles away in Polaris ID and reads them back.
 */
export async function startOffboard(
  ctx: ServiceContext,
  auth: SessionAuth,
  userId: string,
  dryRun: boolean,
  idempotencyKey: string | undefined,
): Promise<{ plan: OffboardPlan; operation: OperationDto | null }> {
  // A replay is answered before any state check: the offboard it made has already emptied the plan.
  const known = dryRun
    ? null
    : await replay(ctx, auth, 'idp.offboard', idempotencyKey, offboardTarget(userId));
  if (known) return { plan: await offboardPlan(ctx, userId), operation: known };
  const plan = await checked(ctx, userId);
  if (dryRun) return { plan, operation: null };
  const [blocker] = plan.blockers;
  if (blocker)
    throw new ConflictError(`${blocker.org.name} needs another org admin first.`, 'LAST_ORG_ADMIN');
  await limited(ctx, auth);
  await endAccess(ctx, auth, plan);
  const operation = await startIdpOp(ctx, auth, {
    kind: 'idp.offboard',
    target: offboardTarget(userId),
    subject: { userId },
    idempotencyKey,
    audit: { action: 'idp.offboard', targetType: 'user', targetId: userId },
  });
  return { plan, operation };
}
