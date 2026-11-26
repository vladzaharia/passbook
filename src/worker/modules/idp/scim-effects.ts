import { bump, read } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import {
  endAdminAccess,
  listLiveSessions,
  revokeSession,
  revokeSessionsWithRole,
} from '../auth/repo-sessions.ts';
import { idpClient } from './client.ts';
import { endSessions, noteDrift } from './effects.ts';
import { idpCodeOf } from './errors.ts';
import { ADMIN_BREAKER } from './reconcile-admins.ts';
import { openDriftOfSubject } from './repo-drift.ts';
import {
  breakerOpen,
  markManyQueued,
  pendingRevocations,
  setRetry,
  setRevocation,
  subjectsOfScimIds,
} from './repo-scim.ts';
import { identityOfSubject, subjectsOfUser } from './repo-sources.ts';
import { identitiesOfSubjects } from './repo-sync.ts';

/**
 * The only things a SCIM push can do (design 1 section 3.4), and none of them gives anything:
 * - a user that goes inactive or is deleted has their Polaris ID sessions ended, once Polaris ID confirms it;
 * - a user taken out of a group is queued for the drain, which reads Polaris ID itself and decides (hold, revoke);
 * - an admin taken out of a group loses their admin sessions when Polaris ID shows them in no admin group.
 * A revocation that cannot be done now is `pending` on the mirror row and the sweep does it later.
 */

/** Session endings in ten minutes. More is a fault in the feed, not an owner's edit: the breaker latches. */
export const SCIM_BREAKER_LIMIT = 20;
const BREAKER_WINDOW_MS = 600_000;
/** A tripped breaker stays open this long, or until a platform admin deletes its counter row (docs/operations.md). */
const BREAKER_LATCH_MS = 86_400_000;
const BREAKER_KEY = 'idp:scim:breaker';
const HOUR = 3_600_000;
/** `lookup` calls a push may spend an hour on confirming deactivations and admin removals. */
export const SCIM_LOOKUPS_PER_HOUR = 60;
/** Members one push queues for the drain, and all pushes together in an hour. */
const SCIM_MARK_LIMIT = 100;
export const SCIM_MARKS_PER_HOUR = 300;
/** Dropped members a push looks at; the rest are left to the daily reconcile. */
const DROP_SCAN = 300;
const SWEEP_BATCH = 20;
/** Roles that say an account still belongs to PassBook's client. */
const REGISTRY = new Set(['console', 'developer', 'support', 'platform_admin', 'users']);

/** `live`: act. `dry`: Polaris ID writes are in dry run, so the feed changes nothing in PassBook yet. `off`: not ready. */
type Gate = 'live' | 'dry' | 'off';
/** `revoked`: sessions ended. `none`: nothing to end. `pending`: owed, recorded on the mirror row. */
export type Outcome = 'revoked' | 'none' | 'pending';
/** Inside, two more: `breaker` (open: a sweep stops) and `retry` (Polaris ID could not confirm: a sweep backs off). */
type Step = Outcome | 'breaker' | 'retry';

/**
 * One health read per push that has an effect to decide. Unreachable, frozen or unsafe is `off`, the same gate as
 * the drain.
 */
async function gateOf(ctx: ServiceContext): Promise<Gate> {
  try {
    const health = await idpClient(ctx.env, ctx.log).health();
    if (health.frozen || !health.ok || health.unsafe.length > 0) return 'off';
    return health.mode === 'live' ? 'live' : 'dry';
  } catch (error) {
    ctx.log.warn('idp.scim.not_ready', { code: codeOf(error) });
    return 'off';
  }
}

const codeOf = (error: unknown): string =>
  error instanceof AppError ? (idpCodeOf(error) ?? error.code) : 'IDP_UNAVAILABLE';

/** Spends one `lookup` of the hour's budget (the drain's own budget is 1,000 a day). False when it is gone. */
async function lookupRoom(ctx: ServiceContext, count = 1): Promise<boolean> {
  const hour = Math.floor(ctx.clock.now() / HOUR) * HOUR;
  return (await bump(ctx.env.DB, 'idp:scim:lookups', hour, count)) <= SCIM_LOOKUPS_PER_HOUR;
}

/** Polaris ID's own answer on whether the feed is right that the account is off or out of PassBook's groups. */
async function confirmed(ctx: ServiceContext, subject: string): Promise<'yes' | 'no' | 'unknown'> {
  if (!(await lookupRoom(ctx))) return 'unknown';
  try {
    const found = await idpClient(ctx.env, ctx.log).lookup(subject);
    return found.disabled || !found.roles.some((r) => REGISTRY.has(r)) ? 'yes' : 'no';
  } catch (error) {
    const code = codeOf(error);
    if (code === 'IDP_NOT_FOUND') return 'yes';
    ctx.log.warn('idp.scim.lookup_failed', { code });
    return 'unknown';
  }
}

interface Revoke {
  subject: string;
  why: 'inactive' | 'deleted';
  /** A sweep ends only sessions started at or before this: one made after the change stays. Null: all of them. */
  before: number | null;
  lastRevokedAt: number | null;
}

/**
 * Ends one subject's Polaris ID sessions (email-link ones stay) when the gate is live, the subject has not been
 * revoked this hour, the breaker is closed, and Polaris ID confirms the account is off, gone or out of the
 * client's groups. Anything that stops it for now is `pending`.
 */
async function revoke(ctx: ServiceContext, gate: Gate, r: Revoke): Promise<Step> {
  if (gate !== 'live') {
    ctx.log.info('idp.scim.effect_skipped', { gate, reason: r.why });
    return 'pending';
  }
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const identity = await identityOfSubject(db, r.subject);
  if (!identity) return 'none';
  if (r.lastRevokedAt !== null && now - r.lastRevokedAt < HOUR) return 'retry';
  if (await breakerOpen(db, BREAKER_KEY, now, BREAKER_LATCH_MS)) return 'breaker';
  const verdict = await confirmed(ctx, r.subject);
  if (verdict === 'unknown') return 'retry';
  if (verdict === 'no') {
    ctx.log.warn('idp.scim.unconfirmed', { code: 'IDP_SCIM_UNCONFIRMED', reason: r.why });
    return 'none';
  }
  const window = Math.floor(now / BREAKER_WINDOW_MS) * BREAKER_WINDOW_MS;
  const count = await bump(db, `idp:scim:revokes:${window}`, window);
  if (count > SCIM_BREAKER_LIMIT) {
    await bump(db, BREAKER_KEY, now);
    // The window's count starts again from zero, so clearing the latch inside the window does not re-latch at once.
    await bump(db, `idp:scim:revokes:${window}`, window, -count);
    ctx.log.error('idp.scim_breaker', { code: 'IDP_SCIM_BREAKER', limit: SCIM_BREAKER_LIMIT });
    return 'breaker';
  }
  // Polaris ID confirmed the account is off: keys made as an admin end, whatever `before` leaves of the sessions
  // (it only spares a session made after a re-enable, not a key made before the change).
  await endAdminAccess(db, identity.user_id);
  const ended =
    r.before === null
      ? await revokeSessionsWithRole(db, identity.user_id, 'user', now)
      : await endSessionsBy(db, identity.user_id, r.before, now);
  if (ended > 0) {
    await recordAudit(ctx, {
      actorType: 'system',
      action: 'idp.sessions_revoked',
      targetType: 'user',
      targetId: identity.user_id,
      detail: { role: 'user', reason: `scim_${r.why}`, count: ended },
    });
    ctx.log.info('idp.sessions_revoked', {
      userId: identity.user_id,
      reason: `scim_${r.why}`,
      count: ended,
    });
  }
  return 'revoked';
}

/** Ends the user's live Polaris ID sessions started at or before `startedBy`, one by one. */
async function endSessionsBy(db: D1Database, userId: string, startedBy: number, now: number) {
  let ended = 0;
  for (const s of await listLiveSessions(db, userId, now))
    if (s.amr === 'oidc' && s.created_at <= startedBy && (await revokeSession(db, s.id_hash, now)))
      ended++;
  return ended;
}

/** A user the owner switched off, or took out of every group the PassBook client allows. */
export async function userDeactivated(
  ctx: ServiceContext,
  subject: string,
  why: 'inactive' | 'deleted',
  lastRevokedAt: number | null,
): Promise<Outcome> {
  const step = await revoke(ctx, await gateOf(ctx), { subject, why, before: null, lastRevokedAt });
  return step === 'breaker' || step === 'retry' ? 'pending' : step;
}

/** True when a revocation is owed: the drain's minute hook then takes the lease and sweeps. */
export const revocationsOwed = async (ctx: ServiceContext): Promise<boolean> =>
  (await pendingRevocations(ctx.env.DB, ctx.clock.now(), 1)).length > 0;

/** A row the sweep could not settle waits 10 minutes, then 20, doubling up to about 5 hours. */
const retryAfter = (tries: number): number => 600_000 * 2 ** Math.min(tries, 5);

/**
 * Carries out the revocations the receiver could not (live gate only, under the breaker and the caps). A row
 * whose user was switched back on has no flag; one that Polaris ID no longer confirms is settled without ending
 * anything.
 */
export async function sweepRevocations(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  for (const row of await pendingRevocations(db, ctx.clock.now(), SWEEP_BATCH)) {
    const step = await revoke(ctx, 'live', {
      subject: row.subject,
      why: row.deleted_at === null ? 'inactive' : 'deleted',
      before: row.last_modified,
      lastRevokedAt: row.revoked_at,
    });
    if (step === 'breaker') return;
    if (step === 'retry')
      await setRetry(
        db,
        row.scim_id,
        row.revoke_tries + 1,
        ctx.clock.now() + retryAfter(row.revoke_tries),
      );
    else if (step !== 'pending')
      await setRevocation(db, row.scim_id, {
        pending: false,
        revokedAt: step === 'revoked' ? ctx.clock.now() : null,
      });
  }
}

/**
 * People whose last sign-in was as platform admin and who left a group: Polaris ID is asked about each of their
 * accounts (`lookup`, no new call). A person stays admin while any account is in the admin group; a failed or
 * over-budget lookup is unknown and left to the daily reconcile. More than `ADMIN_BREAKER` people at once is a
 * fault in the feed: reported, nothing revoked, and no difference filed (the reconcile will, once it has seen).
 */
async function adminsDropped(
  ctx: ServiceContext,
  people: ReadonlyMap<string, string>,
): Promise<void> {
  if (people.size === 0) return;
  if (people.size > ADMIN_BREAKER) {
    ctx.log.error('idp.scim.admin_breaker', { code: 'IDP_BREAKER', count: people.size });
    return;
  }
  const db = ctx.env.DB;
  const rpc = idpClient(ctx.env, ctx.log);
  const runId = ctx.ids.id();
  for (const [userId, first] of people) {
    const subjects = await subjectsOfUser(db, userId);
    const reported = (await Promise.all(subjects.map((s) => openDriftOfSubject(db, s)))).flat();
    if (reported.some((d) => d.kind === 'admin_changed')) continue;
    if (!(await lookupRoom(ctx, subjects.length))) continue;
    let stillAdmin = false;
    let known = true;
    for (const subject of subjects) {
      try {
        if ((await rpc.lookup(subject)).roles.includes('platform_admin')) stillAdmin = true;
      } catch (error) {
        ctx.log.warn('idp.scim.lookup_failed', { code: codeOf(error) });
        known = false;
      }
    }
    if (stillAdmin || !known) continue;
    const who = { subject: first, userId };
    await noteDrift(ctx, runId, who, 'console', 'admin_changed');
    await endSessions(ctx, who, 'admin', 'scim_admin_removed');
  }
}

/**
 * Users no longer in a group. Admins among them are checked at once; the linked ones are queued for the drain
 * (within an hourly budget, keeping the backoff of any that are failing). Polaris ID does not say which role a
 * group is, so the drain reads the account and classifies each role, as it does for a PassBook change.
 */
export async function membersRemoved(
  ctx: ServiceContext,
  scimIds: readonly string[],
): Promise<void> {
  if (scimIds.length === 0) return;
  if ((await gateOf(ctx)) !== 'live') return;
  const db = ctx.env.DB;
  const subjects = [...(await subjectsOfScimIds(db, scimIds.slice(0, DROP_SCAN))).values()];
  const identities = await identitiesOfSubjects(db, subjects);
  const admins = new Map<string, string>();
  for (const [subject, i] of identities)
    if (i.last_roles.includes('"admin"') && i.status === 'active') admins.set(i.user_id, subject);
  await adminsDropped(ctx, admins);
  const hour = Math.floor(ctx.clock.now() / HOUR) * HOUR;
  const room = SCIM_MARKS_PER_HOUR - (await read(db, 'idp:scim:marks', hour));
  const marked = [...identities.keys()].slice(0, Math.max(0, Math.min(SCIM_MARK_LIMIT, room)));
  if (marked.length > 0) {
    await bump(db, 'idp:scim:marks', hour, marked.length);
    await markManyQueued(db, marked);
  }
  ctx.log.info('idp.scim.members_queued', { queued: marked.length, dropped: identities.size });
}
