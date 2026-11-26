import type { AccessView } from '../../../shared/contracts/idp-access.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { liveSponsorsOfUser } from '../dev-access/repo-sponsors.ts';
import { requireUser } from '../users/service.ts';
import { idpClient, idpConfigured } from './client.ts';
import { isPlatformAdmin } from './desired.ts';
import { idpCodeOf } from './errors.ts';
import { activePlatformGrants } from './repo-role-grants.ts';
import { membershipSources, subjectsOfUser } from './repo-sources.ts';
import { statesOfUser } from './repo-state.ts';
import { orgInfo } from './repo-user-access.ts';
import { WRITABLE_ROLES } from './types.ts';

/** The account's class and state, from Polaris ID. A failed read is logged with its code and leaves them unknown. */
async function accountOf(ctx: ServiceContext, subjects: string[]): Promise<AccessView['account']> {
  const [subject] = subjects;
  if (!subject || subjects.length > 1 || !idpConfigured(ctx.env))
    return { class: null, disabledInIdp: null };
  try {
    const lookup = await idpClient(ctx.env, ctx.log).lookup(subject);
    return { class: lookup.class, disabledInIdp: lookup.disabled };
  } catch (error) {
    ctx.log.warn('idp.access_lookup_failed', { code: idpCodeOf(error) ?? 'IDP_UNAVAILABLE' });
    return { class: null, disabledInIdp: null };
  }
}

/**
 * A user's Polaris ID access, for the Access card: per role what PassBook wants and why, what the last read of
 * Polaris ID showed, and a pause. Wanted follows the same rules as the drain (design 1 section 3.2).
 */
export async function accessView(ctx: ServiceContext, userId: string): Promise<AccessView> {
  const user = await requireUser(ctx, userId);
  const db = ctx.env.DB;
  const admin = isPlatformAdmin(user.last_roles);
  const disabled = user.status === 'disabled';
  const live = !admin && !disabled;
  const [memberships, sponsorships, grants, states, subjects] = await Promise.all([
    membershipSources(db, userId),
    liveSponsorsOfUser(db, userId),
    activePlatformGrants(db, userId),
    statesOfUser(db, userId),
    subjectsOfUser(db, userId),
  ]);
  const names = await orgInfo(db, [
    ...memberships.map((m) => m.org_id),
    ...sponsorships.map((s) => s.org_id),
  ]);
  const org = (id: string) => ({ org: { id, name: names.get(id)?.name ?? '' } });
  const roles = WRITABLE_ROLES.map((role) => {
    const mine = states.filter((s) => s.target === role);
    const grant = grants.find((g) => g.role === role);
    const memberOf = role === 'console' ? memberships.map((m) => org(m.org_id)) : [];
    const sponsorOf = role === 'developer' ? sponsorships.map((s) => org(s.org_id)) : [];
    const seen = mine.filter((s) => s.observed !== null);
    return {
      role,
      wanted: live && (memberOf.length > 0 || sponsorOf.length > 0 || grant !== undefined),
      present: seen.length === 0 ? null : seen.some((s) => s.observed === 1),
      presence: mine.some((s) => s.presence === 'passbook')
        ? ('passbook' as const)
        : mine.some((s) => s.presence === 'external')
          ? ('external' as const)
          : ('none' as const),
      held: mine.some((s) => s.held_at !== null),
      memberships: memberOf,
      sponsorships: sponsorOf,
      grantedAt: grant?.created_at ?? null,
      error: mine.find((s) => s.error_code)?.error_code ?? null,
    };
  });
  return {
    userId,
    connected: idpConfigured(ctx.env),
    platformAdmin: admin,
    disabled,
    linked: subjects.length > 0,
    account: await accountOf(ctx, subjects),
    roles,
  };
}
