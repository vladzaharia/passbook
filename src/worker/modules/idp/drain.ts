import { bump } from '../../platform/counters.ts';
import { chunk } from '../../platform/db.ts';
import { closeDeveloperSandbox } from '../developer/jobs.ts';
import { classify, presenceOf } from './classify.ts';
import { desiredState, targetKeys } from './desired.ts';
import { failure } from './drain-failure.ts';
import {
  addedTarget,
  auditEffect,
  closeDrift,
  endSessions,
  failTarget,
  holdTargetForOwner,
  noteDrift,
  observeTarget,
  removedTarget,
  settleSponsorships,
  type Who,
} from './effects.ts';
import { idpCodeOf } from './errors.ts';
import type { DirtyRow } from './repo-dirty.ts';
import { type DriftRow, openDriftOfSubject } from './repo-drift.ts';
import { statesOfSubject } from './repo-state.ts';
import {
  type DrainOutcome,
  HOLD_CAP,
  isManaged,
  type RunEnv,
  rpcCtx,
  type Touched,
} from './run-env.ts';
import type { ApplyResult, Target } from './types.ts';

const BATCH = 10;

/**
 * Brings one Polaris ID subject to its desired state (design 1 section 3.4): reads D1 and Polaris ID, decides
 * each target with `classify` (the owner wins), and sends one `apply` for what changes. Repeating it with
 * nothing new sends nothing. The caller clears, backs off or keeps the mark by the outcome.
 */
export async function drainSubject(env: RunEnv, row: DirtyRow): Promise<DrainOutcome> {
  const touched: Touched = { targets: [] };
  try {
    const targets = await plan(env, row.subject, touched);
    return { mark: 'clear', stop: false, targets };
  } catch (error) {
    return {
      ...(await failure(env, row.subject, touched, error)),
      targets: touched.targets.length,
    };
  }
}

/** Returns how many targets it looked at. */
async function plan(env: RunEnv, subject: string, touched: Touched): Promise<number> {
  const { ctx, rpc, runId, dry } = env;
  const db = ctx.env.DB;
  const desired = await desiredState(db, subject, ctx.clock.now());
  const who: Who = { subject, userId: desired.userId };
  touched.targets = targetKeys(desired);
  if (desired.skip === 'platform_admin') return 0;
  const lookup = await rpc.lookup(subject);
  if (lookup.isAdmin) return 0;

  const states = new Map((await statesOfSubject(db, subject)).map((s) => [s.target, s]));
  const open = await openDriftOfSubject(db, subject);
  const wantsNothing = desired.skip === 'disabled';
  const present = new Set(lookup.roles.filter(isManaged));
  const grants = new Set(lookup.grants);
  const confirmed = new Set(lookup.confirmedGrants);
  const everyTarget = new Set<Target>([
    ...desired.targets.keys(),
    ...present,
    ...grants,
    ...states.keys(),
  ]);

  let account: 'ready' | 'would' | 'no' = 'ready';
  if (lookup.disabled && !wantsNothing) account = await enable(env, who, lookup.class);

  // A developer role taken back whose sandbox did not close: the error stays on the target until it does.
  const pendingClose = states.get('developer')?.error_code === 'SANDBOX_CLOSE_FAILED';
  const record = (target: Target, code: string) =>
    dry ? Promise.resolve() : failTarget(ctx, who, target, code);
  const observe = (
    target: Target,
    seen: Parameters<typeof observeTarget>[3],
    before: Parameters<typeof observeTarget>[4],
  ) =>
    dry || (pendingClose && target === 'developer')
      ? Promise.resolve()
      : observeTarget(ctx, who, target, seen, before);

  const adds: Target[] = [];
  const removes: Target[] = [];
  for (const target of [...everyTarget].sort()) {
    const s = states.get(target);
    const facts = {
      present: present.has(target),
      grant: grants.has(target),
      wanted: !wantsNothing && desired.targets.has(target),
      held: s?.held_at != null,
      // A read-back grant stands in for an observation only until PassBook has observed the target once: after
      // an observed absence (a hold, then Restore) the grant outlives the role and must not block the re-add.
      seen: s?.observed === 1 || (s?.observed == null && confirmed.has(target)),
    };
    const presence = presenceOf(facts);
    switch (classify(facts)) {
      case 'ok':
        await observe(target, { present: true, presence }, s);
        await closeDrift(ctx, who, target, open, ['missing', 'unexpected', 'apply_failed'], 'ok');
        break;
      case 'external':
        await observe(target, { present: true, presence }, s);
        await noteDrift(ctx, runId, who, target, 'external_added', open);
        await closeDrift(ctx, who, target, open, ['missing', 'unexpected'], 'external');
        break;
      case 'none':
      case 'held':
        await observe(target, { present: false, presence: 'none' }, s);
        await closeDrift(ctx, who, target, open, ['missing', 'unexpected'], 'gone');
        break;
      case 'hold':
        await holdOrReport(env, who, target, open);
        break;
      case 'add':
        if (env.blocked.has(target)) await record(target, 'IDP_BLOCKED');
        else if (account === 'would') await noteDrift(ctx, runId, who, target, 'missing', open);
        else if (account === 'no')
          await noteDrift(ctx, runId, who, target, 'disabled_in_idp', open);
        else {
          // A pending grant (never read back, never observed) may have lost its write, so it goes in again.
          if (facts.grant)
            ctx.log.warn('idp.access_readded', { code: 'IDP_READDED', subject, target });
          adds.push(target);
        }
        break;
      case 'remove':
      case 'settle':
        if (env.blocked.has(target)) await record(target, 'IDP_BLOCKED');
        else removes.push(target);
        break;
    }
  }

  const why = wantsNothing ? 'user_disabled' : 'no_reason';
  for (const part of chunk(removes, BATCH))
    await send(env, who, { remove: part }, why, touched, grants, open);
  for (const part of chunk(adds, BATCH))
    await send(env, who, { add: part }, 'drain', touched, grants, open);

  if (wantsNothing && lookup.class === 'created' && !lookup.disabled) await disable(env, who);
  if (!dry) {
    const wantsDeveloper = !wantsNothing && desired.targets.has('developer');
    const taking = removes.includes('developer');
    // From state, not only from this run's removal: a held role, or one never present, still has its sandbox.
    const gone = !present.has('developer') && (pendingClose || states.has('developer'));
    const closing = !wantsDeveloper && (taking || gone);
    if (closing) await closeSandbox(env, who, pendingClose);
    await settleSponsorships(ctx, who);
  }
  return everyTarget.size;
}

/**
 * The developer role is gone and nothing wants it: the person's developer sandbox closes in the same run (its
 * org's status change then marks the subject, so console goes next). A failure keeps the error on the target and
 * fails the mark, so the close is tried again and sponsorships settle only after it worked.
 */
async function closeSandbox(env: RunEnv, who: Who, pending: boolean): Promise<void> {
  const { ctx } = env;
  if (!who.userId) return;
  try {
    await closeDeveloperSandbox(ctx, who.userId);
  } catch (error) {
    ctx.log.warn('idp.sandbox_close_failed', {
      code: 'SANDBOX_CLOSE_FAILED',
      userId: who.userId,
      error,
    });
    await failTarget(ctx, who, 'developer', 'SANDBOX_CLOSE_FAILED');
    throw error;
  }
  if (pending)
    await observeTarget(ctx, who, 'developer', { present: false, presence: 'none' }, undefined);
}

/**
 * The owner took a role PassBook saw: hold it and end its sessions. A dry run, or more removals in the hour than
 * a feed fault would explain (`HOLD_CAP`, counted per hour like the breaker's `ref`, across runs), records the
 * difference and changes nothing.
 */
export async function holdOrReport(
  env: RunEnv,
  who: Who,
  target: Target,
  open: readonly DriftRow[],
): Promise<void> {
  const { ctx, runId } = env;
  if (env.dry) return noteDrift(ctx, runId, who, target, 'owner_removed', open);
  const hour = Math.floor(ctx.clock.now() / 3_600_000);
  const held = await bump(ctx.env.DB, `idp:holds:${hour}`, hour * 3_600_000);
  if (held > HOLD_CAP) {
    if (held === HOLD_CAP + 1)
      ctx.log.error('idp.hold_breaker', { code: 'IDP_HOLD_BREAKER', limit: HOLD_CAP });
    return noteDrift(ctx, runId, who, target, 'owner_removed', open);
  }
  await holdTargetForOwner(ctx, runId, who, target);
}

/**
 * Re-enables an account PassBook disabled once the user is active again. `would`: a dry run, adds are only
 * reported. `no`: the owner disabled it, nothing is added and its Polaris ID sessions end.
 */
async function enable(env: RunEnv, who: Who, klass: string): Promise<'ready' | 'would' | 'no'> {
  if (klass === 'created') {
    try {
      const reason = rpcCtx(env, 'drain', 'user_enabled');
      const result = await env.rpc.setDisabled(who.subject, false, reason);
      if (result.dryRun) return 'would';
      if (result.result === 'enabled') await auditEffect(env.ctx, 'idp.account_enabled', who, {});
      return 'ready';
    } catch (error) {
      if (idpCodeOf(error) !== 'IDP_NOT_MANAGED') throw error;
    }
  }
  if (!env.dry) await endSessions(env.ctx, who, 'user', 'disabled_in_idp');
  return 'no';
}

/** A disabled PassBook user's account, when PassBook created it and it holds nothing outside its groups. */
async function disable(env: RunEnv, who: Who): Promise<void> {
  try {
    const result = await env.rpc.setDisabled(
      who.subject,
      true,
      rpcCtx(env, 'drain', 'user_disabled'),
    );
    if (result.result === 'disabled' && !result.dryRun)
      await auditEffect(env.ctx, 'idp.account_disabled', who, {});
  } catch (error) {
    if (idpCodeOf(error) !== 'IDP_NOT_MANAGED') throw error;
    env.ctx.log.info('idp.drain.account_kept', { subject: who.subject });
  }
}

type Delta = { add?: Target[]; remove?: Target[] };

/**
 * One `apply`. When Polaris ID refuses a multi-target call (one custom group may be gone), each target is sent
 * alone so the others still go through.
 */
async function send(
  env: RunEnv,
  who: Who,
  delta: Delta,
  why: string,
  touched: Touched,
  grants: ReadonlySet<Target>,
  open: Parameters<typeof closeDrift>[3],
): Promise<void> {
  const targets = [...(delta.add ?? []), ...(delta.remove ?? [])];
  touched.targets = targets;
  const ctx = rpcCtx(env, 'drain', why);
  try {
    await settle(env, who, delta, await env.rpc.apply(who.subject, delta, ctx), why, grants, open);
  } catch (error) {
    if (idpCodeOf(error) !== 'IDP_REFUSED' || targets.length < 2) throw error;
    for (const target of targets) {
      const one: Delta = delta.add ? { add: [target] } : { remove: [target] };
      touched.targets = [target];
      try {
        await settle(env, who, one, await env.rpc.apply(who.subject, one, ctx), why, grants, open);
      } catch (inner) {
        if (idpCodeOf(inner) !== 'IDP_REFUSED') throw inner;
        if (!env.dry) await failTarget(env.ctx, who, target, 'IDP_REFUSED');
      }
    }
  }
}

/** Records what an `apply` did. A dry run records differences only. */
async function settle(
  env: RunEnv,
  who: Who,
  delta: Delta,
  result: ApplyResult,
  why: string,
  grants: ReadonlySet<Target>,
  open: Parameters<typeof closeDrift>[3],
): Promise<void> {
  const { ctx, runId } = env;
  for (const target of result.added) {
    if (result.dryRun) await noteDrift(ctx, runId, who, target, 'missing', open);
    else {
      await addedTarget(ctx, who, target);
      await closeDrift(ctx, who, target, open, ['missing', 'disabled_in_idp'], 'applied');
    }
  }
  for (const target of result.removed) {
    if (result.dryRun) await noteDrift(ctx, runId, who, target, 'unexpected', open);
    else {
      await removedTarget(ctx, who, target, why);
      await closeDrift(ctx, who, target, open, ['unexpected'], 'applied');
    }
  }
  for (const { role, reason } of result.skipped) {
    const adding = delta.add?.includes(role) ?? false;
    if (env.dry) continue;
    if (adding && reason === 'already') {
      const presence = presenceOf({ present: true, grant: grants.has(role) });
      await observeTarget(ctx, who, role, { present: true, presence }, undefined);
    } else if (!adding && reason === 'absent' && !result.dryRun) {
      await removedTarget(ctx, who, role, why);
    } else if (!adding && reason === 'not_ours') {
      await observeTarget(ctx, who, role, { present: true, presence: 'external' }, undefined);
    }
  }
}
