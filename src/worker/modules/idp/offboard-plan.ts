import type { OffboardPlan } from '../../../shared/contracts/idp-access.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { liveSponsorsOfUser } from '../dev-access/repo-sponsors.ts';
import { sandboxOfUser } from '../developer/repo.ts';
import { requireUser } from '../users/service.ts';
import { isAdminRoles } from './dto.ts';
import { activePlatformGrants } from './repo-role-grants.ts';
import { statesOfUser } from './repo-state.ts';
import {
  livePersonalKeyCount,
  liveSessionCount,
  membershipsOfUser,
  orgInfo,
  platformKeysMadeBy,
} from './repo-user-access.ts';
import { WRITABLE_ROLES } from './types.ts';

/** An org whose membership ends only through an active org: a suspended one is kept and reported. */
const REVOCABLE = 'active';

/**
 * What offboarding a user ends (design 1 section 4.4), read from D1 alone. The dry run returns this; the real
 * run ends exactly these and nothing else. A platform admin is refused before this is asked.
 */
export async function offboardPlan(ctx: ServiceContext, userId: string): Promise<OffboardPlan> {
  const db = ctx.env.DB;
  const [memberships, sponsors, grants, states, keys, sandbox] = await Promise.all([
    membershipsOfUser(db, userId),
    liveSponsorsOfUser(db, userId),
    activePlatformGrants(db, userId),
    statesOfUser(db, userId),
    platformKeysMadeBy(db, userId),
    sandboxOfUser(db, userId),
  ]);
  const revoked = memberships.filter((m) => m.org_status === REVOCABLE);
  const orgs = await orgInfo(
    db,
    sponsors.map((s) => s.org_id),
  );
  const sponsorOrgs = sponsors.filter((s) => orgs.get(s.org_id)?.status === REVOCABLE);
  const removes = WRITABLE_ROLES.filter((role) =>
    states.some((s) => s.target === role && s.observed === 1 && s.presence === 'passbook'),
  );
  const external = WRITABLE_ROLES.filter((role) =>
    states.some((s) => s.target === role && s.observed === 1 && s.presence === 'external'),
  );
  return {
    userId,
    memberships: revoked.map((m) => ({
      membershipId: m.membership_id,
      orgId: m.org_id,
      name: m.org_name,
    })),
    kept: memberships
      .filter((m) => m.org_status !== REVOCABLE)
      .map((m) => ({ orgId: m.org_id, name: m.org_name })),
    sponsorships: sponsorOrgs.map((s) => ({
      orgId: s.org_id,
      name: orgs.get(s.org_id)?.name ?? '',
    })),
    grants: grants.map((g) => g.role),
    personalKeys: await livePersonalKeyCount(
      db,
      memberships.map((m) => m.membership_id),
    ),
    platformKeys: keys,
    sessions: await liveSessionCount(db, userId, ctx.clock.now()),
    sandboxOrgId: sandbox && sandbox.closed_at === null ? sandbox.org_id : null,
    removes,
    external,
    blockers: revoked
      .filter((m) => m.last_admin === 1)
      .map((m) => ({ orgId: m.org_id, name: m.org_name, code: 'LAST_ORG_ADMIN' as const })),
  };
}

/** The user row, refused for a platform admin: they keep everything implied and the binding refuses them. */
export async function offboardable(ctx: ServiceContext, userId: string) {
  const user = await requireUser(ctx, userId);
  return { user, admin: isAdminRoles(user.last_roles) };
}
