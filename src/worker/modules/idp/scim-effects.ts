import { bump } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { idpClient } from './client.ts';
import { endSessions } from './effects.ts';
import { idpCodeOf } from './errors.ts';
import { subjectsOfScimIds } from './repo-scim.ts';
import { identityOfSubject } from './repo-sources.ts';
import { identitiesOfSubjects, markManyDirty } from './repo-sync.ts';

/**
 * The only things a SCIM push can do (design 1 section 3.4), and none of them gives anything:
 * - a user that goes inactive or is deleted ends that subject's Polaris ID sessions;
 * - a user taken out of a group is queued for the drain, which reads Polaris ID itself and decides (hold, revoke).
 * Nothing read from the feed adds a role, a session, a membership or a user.
 */

/** Deactivations and deletions that end sessions in ten minutes. More is a fault in the feed, not an owner's edit. */
export const SCIM_BREAKER_LIMIT = 20;
const BREAKER_WINDOW_MS = 600_000;
/** Group members one push queues for the drain. The rest are left to the daily reconcile. */
const SCIM_MARK_LIMIT = 100;

/** `live`: act. `dry`: Polaris ID writes are in dry run, so the feed changes nothing in PassBook either. `off`: not ready. */
type Gate = 'live' | 'dry' | 'off';

/**
 * One health read per push that has an effect to decide. Unreachable, frozen or unsafe is `off`, the same gate as
 * the drain: the mirror still updates and the daily reconcile finds what the push would have acted on.
 */
async function gateOf(ctx: ServiceContext): Promise<Gate> {
  try {
    const health = await idpClient(ctx.env, ctx.log).health();
    if (health.frozen || !health.ok || health.unsafe.length > 0) return 'off';
    return health.mode === 'live' ? 'live' : 'dry';
  } catch (error) {
    const code = error instanceof AppError ? (idpCodeOf(error) ?? error.code) : 'IDP_UNAVAILABLE';
    ctx.log.warn('idp.scim.not_ready', { code });
    return 'off';
  }
}

/** A user the owner switched off, or took out of every group the PassBook client allows. */
export async function userDeactivated(
  ctx: ServiceContext,
  subject: string,
  why: 'inactive' | 'deleted',
): Promise<void> {
  const gate = await gateOf(ctx);
  if (gate !== 'live') {
    ctx.log.info('idp.scim.effect_skipped', { gate, reason: why });
    return;
  }
  const identity = await identityOfSubject(ctx.env.DB, subject);
  if (!identity) return;
  const window = Math.floor(ctx.clock.now() / BREAKER_WINDOW_MS) * BREAKER_WINDOW_MS;
  const count = await bump(ctx.env.DB, `idp:scim:revokes:${window}`, window);
  if (count > SCIM_BREAKER_LIMIT) {
    if (count === SCIM_BREAKER_LIMIT + 1)
      ctx.log.error('idp.scim_breaker', { code: 'IDP_SCIM_BREAKER', limit: SCIM_BREAKER_LIMIT });
    return;
  }
  await endSessions(ctx, { subject, userId: identity.user_id }, 'user', `scim_${why}`);
}

/**
 * Users no longer in a group: queue the linked ones for the drain. Polaris ID does not say which role a group
 * is, so the drain reads the account and classifies each role, as it does for a PassBook change.
 */
export async function membersRemoved(
  ctx: ServiceContext,
  scimIds: readonly string[],
): Promise<void> {
  if (scimIds.length === 0) return;
  if ((await gateOf(ctx)) !== 'live') return;
  const subjects = [...(await subjectsOfScimIds(ctx.env.DB, scimIds)).values()];
  const linked = [...(await identitiesOfSubjects(ctx.env.DB, subjects)).keys()];
  const marked = linked.slice(0, SCIM_MARK_LIMIT);
  await markManyDirty(ctx.env.DB, marked);
  ctx.log.info('idp.scim.members_queued', {
    queued: marked.length,
    skipped: linked.length - marked.length,
  });
}
