import { IdpRoleSchema } from '../../../shared/contracts/idp-ops.ts';
import type { OperationDto, OperationResult } from '../../../shared/contracts/operations.ts';
import { countQueries } from '../../jobs/query-counter.ts';
import { AppError, ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import type { Progress } from '../operations/progress-types.ts';
import { releaseLease, rowById } from '../operations/repo.ts';
import { idpClient } from './client.ts';
import { desiredState } from './desired.ts';
import { drainSubject } from './drain.ts';
import { openGate, RECONCILE_QUERY_CAP } from './jobs.ts';
import { reconcile } from './reconcile.ts';
import { clearDirty, dirtyOf, failDirty, markDirty } from './repo-dirty.ts';
import { dropLease, renewLease, SYNC_LEASE, takeLease } from './repo-lease.ts';
import { breakerOpen, clearBreakerAt, countOwed } from './repo-scim.ts';
import { hasLiveAdminSession, subjectsOfUser } from './repo-sources.ts';
import { clearHold, stateOf, statesOfUser } from './repo-state.ts';
import type { RunEnv } from './run-env.ts';
import { BREAKER_KEY, BREAKER_LATCH_MS } from './scim-effects.ts';
import type { WritableRole } from './types.ts';

/** A run that finds the sync lease taken tries again this often, and fails after `BUSY_GIVE_UP_MS`. */
const BUSY_RETRY_S = 30;
const BUSY_GIVE_UP_MS = 10 * 60_000;
/** A manual check or dry run is refused with fewer than this many snapshots left today (30 a day). */
const SNAPSHOT_RESERVE = 5;

/** The restore's target: the user and the role, as `<userId>:<role>`. */
export const restoreTarget = (userId: string, role: WritableRole) => ({
  type: 'user_role',
  id: `${userId}:${role}`,
});

/** The user and role a restore is pinned to, read from its target and checked as the start checked them. */
function holdOf(op: OperationDto): { userId: string; role: WritableRole } {
  const id = op.target?.id ?? '';
  const cut = id.lastIndexOf(':');
  const role = IdpRoleSchema.safeParse(id.slice(cut + 1));
  if (op.target?.type !== 'user_role' || cut < 1 || !role.success)
    throw new AppError('IDP_HOLD_NOT_FOUND', 404, 'This role is not paused.');
  return { userId: id.slice(0, cut), role: role.data };
}

/**
 * The admin who started it still is one: an active user with a live, unrevoked Polaris ID admin session. A run has
 * no session of its own; a demotion in Polaris ID ends those sessions through SCIM before `last_roles` moves.
 */
export async function adminStill(ctx: ServiceContext, op: OperationDto): Promise<void> {
  if (
    !op.startedBy.id ||
    !(await hasLiveAdminSession(ctx.env.DB, op.startedBy.id, ctx.clock.now()))
  )
    throw new ForbiddenError('Platform admin access ended.', 'IDP_ADMIN_ENDED');
}

/** A run that holds a lease checks it still does before a domain write: a twin that took it over wins. */
export async function held(ctx: ServiceContext, op: OperationDto, lease: string): Promise<void> {
  const owner = (await rowById(ctx.env.DB, op.id))?.lease_owner;
  if (owner && owner !== lease)
    throw new AppError('OPERATION_LEASE_LOST', 409, 'Another runner took this over.');
}

/**
 * Takes the lease the drain and the reconcile share. When another run holds it, the step waits and a delayed
 * `operation.run` looks again; after ten minutes it fails. No sleeping in the job.
 */
export async function takeSync(
  ctx: ServiceContext,
  op: OperationDto,
  progress: Progress,
  step: string,
  lease: string,
): Promise<string | null> {
  const holder = ctx.ids.id();
  const now = ctx.clock.now();
  if (await takeLease(ctx.env.DB, SYNC_LEASE, holder, now)) return holder;
  // From this attempt's first wait: a retry restarts the budget (a retry clears the failed step's start).
  const since = op.steps.find((x) => x.key === step)?.startedAt ?? now;
  if (now - since > BUSY_GIVE_UP_MS)
    throw new AppError('IDP_SYNC_BUSY', 409, 'Another Polaris ID sync is still running.');
  await progress.waiting(step, {
    until: now + BUSY_RETRY_S * 1000,
    reason: 'Waiting for the running sync',
  });
  await releaseLease(ctx.env.DB, op.id, op.attempt, lease);
  // Sent here, not through `operations/jobs.ts`: that module imports the runners, which import this file.
  await ctx.env.JOBS.send(
    { kind: 'operation.run', operationId: op.id, attempt: op.attempt },
    { delaySeconds: BUSY_RETRY_S },
  );
  return null;
}

export const notReady = () =>
  new AppError('IDP_NOT_READY', 503, 'Polaris ID is paused or not reachable.');

/** Check now and the dry run: one reconcile under the sync lease. `forceDry` records differences and changes nothing. */
export async function checkRun(
  ctx: ServiceContext,
  op: OperationDto,
  lease: string,
  forceDry: boolean,
): Promise<void> {
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  await adminStill(ctx, op);
  progress.step('connect');
  const holder = await takeSync(ctx, op, progress, 'connect', lease);
  if (!holder) return;
  const counter = countQueries(ctx.env);
  const db = counter.env.DB;
  try {
    const rpc = idpClient(counter.env, ctx.log);
    const gate = await openGate(ctx, rpc, 'idp.check');
    if (!gate) throw notReady();
    // The snapshot budget (per day) is shared with the daily reconcile: a manual check leaves it its share.
    const snapshot = (await rpc.health()).budget.snapshot;
    const left = snapshot ? snapshot.limit - snapshot.day : null;
    if (left !== null && left < SNAPSHOT_RESERVE)
      throw new AppError('IDP_BUDGET_LOW', 429, 'Too few Polaris ID reads left today.');
    await progress.step('connect').done();
    progress.step('compare');
    await held(ctx, op, lease);
    const env: RunEnv = {
      ctx: { ...ctx, env: counter.env },
      rpc,
      runId: ctx.ids.id(),
      ...gate,
      dry: gate.dry || forceDry,
      renew: async () => void (await renewLease(db, SYNC_LEASE, holder, ctx.clock.now())),
    };
    const report = await reconcile(env, counter.count, RECONCILE_QUERY_CAP);
    if (!report) throw new AppError('IDP_UNAVAILABLE', 503, 'Polaris ID is not reachable.');
    await progress.step('compare').done();
    await progress.succeed({
      href: null,
      ids: {
        dryRun: env.dry ? 'yes' : 'no',
        members: String(report.members),
        external: String(report.external),
        unknown: String(report.unknown),
        held: String(report.held),
        marked: String(report.marked),
        capped: report.capped ? 'yes' : 'no',
        ...(left === null ? {} : { snapshotsLeft: String(left - 1) }),
      },
    });
  } finally {
    await dropLease(db, SYNC_LEASE, holder);
  }
}

/** The Polaris ID subject whose hold this is: the held one, else the user's only account. */
async function subjectOf(ctx: ServiceContext, userId: string, role: WritableRole): Promise<string> {
  const db = ctx.env.DB;
  const heldRow = (await statesOfUser(db, userId)).find((s) => s.target === role && s.held_at);
  if (heldRow) return heldRow.subject;
  const subjects = await subjectsOfUser(db, userId);
  const [only] = subjects;
  if (!only || subjects.length > 1)
    throw new ConflictError("This user isn't in Polaris ID.", 'IDP_NO_ACCOUNT');
  return only;
}

/**
 * Restore: clear the pause, then bring the one subject to its desired state under the sync lease and read the
 * role back. The run is pinned to the operation's own user and role. In dry run the pause clears and nothing is sent.
 */
export async function restoreRun(
  ctx: ServiceContext,
  op: OperationDto,
  lease: string,
): Promise<void> {
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  await adminStill(ctx, op);
  const { userId, role } = holdOf(op);
  const db = ctx.env.DB;
  const subject = await subjectOf(ctx, userId, role);
  // The pause is the only memory of the owner's "no": a user who is off, or a role no reason wants, keeps it.
  if (!(await desiredState(db, subject, ctx.clock.now())).targets.has(role))
    throw new ConflictError('Nothing wants this role now.', 'IDP_NOT_WANTED');
  progress.step('release');
  await held(ctx, op, lease);
  await clearHold(db, subject, role);
  await markDirty(db, subject);
  await progress.step('release').done();
  progress.step('apply');
  const holder = await takeSync(ctx, op, progress, 'apply', lease);
  if (!holder) return;
  try {
    const rpc = idpClient(ctx.env, ctx.log);
    const gate = await openGate(ctx, rpc, 'idp.restore');
    if (!gate) throw notReady();
    if (gate.dry) {
      await progress.step('apply').skip();
      await progress.step('confirm').skip();
      await progress.succeed({ href: null, ids: { added: 'no', dryRun: 'yes' } });
      return;
    }
    const mark = await dirtyOf(db, subject);
    if (mark) {
      await held(ctx, op, lease);
      const env: RunEnv = {
        ctx,
        rpc,
        runId: ctx.ids.id(),
        ...gate,
        renew: async () => void (await renewLease(db, SYNC_LEASE, holder, ctx.clock.now())),
      };
      const outcome = await drainSubject(env, mark);
      if (outcome.mark === 'clear') await clearDirty(db, subject, mark.version);
      else if (outcome.mark === 'fail') await failDirty(db, subject, mark.version, ctx.clock.now());
      if (outcome.mark === 'fail')
        throw new AppError('IDP_APPLY_FAILED', 502, 'Polaris ID did not accept the change.');
      if (outcome.stop) throw notReady();
    }
    await progress.step('apply').done();
    progress.step('confirm');
    const state = await stateOf(db, subject, role);
    if (state?.observed !== 1)
      throw new AppError('IDP_NOT_APPLIED', 502, 'Polaris ID did not add the role.');
    await progress.step('confirm').done();
    await progress.succeed({ href: null, ids: { added: 'yes' } });
  } finally {
    await dropLease(db, SYNC_LEASE, holder);
  }
}

/**
 * Clear the SCIM breaker the admin saw (the target carries when it latched): rows from a later trip stay, and a trip
 * after the delete stops the run, non-retryable. What is owed ends on the next minute's sweep, up to 20 at a time.
 */
export async function breakerRun(
  ctx: ServiceContext,
  op: OperationDto,
  lease: string,
): Promise<void> {
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  const db = ctx.env.DB;
  await adminStill(ctx, op);
  const trippedAt = Number(op.target?.id);
  if (op.target?.type !== 'scim_breaker' || !Number.isSafeInteger(trippedAt))
    throw new AppError('IDP_BREAKER_CLOSED', 409, 'The SCIM breaker is not tripped.');
  progress.step('clear');
  await held(ctx, op, lease);
  await clearBreakerAt(db, BREAKER_KEY, trippedAt);
  await progress.step('clear').done();
  progress.step('confirm');
  if (await breakerOpen(db, BREAKER_KEY, ctx.clock.now(), BREAKER_LATCH_MS))
    throw new AppError('IDP_BREAKER_RETRIPPED', 409, 'The breaker tripped again.');
  const owed = await countOwed(db, ctx.clock.now());
  await progress.step('confirm').done();
  const result: OperationResult = { href: null, ids: { owed: String(owed) } };
  await progress.succeed(result);
}
