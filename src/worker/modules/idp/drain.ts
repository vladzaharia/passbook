import { chunk } from '../../platform/db.ts';
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
import { openDriftOfSubject } from './repo-drift.ts';
import { statesOfSubject } from './repo-state.ts';
import { type DrainOutcome, isManaged, type RunEnv, rpcCtx, type Touched } from './run-env.ts';
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
    await plan(env, row.subject, touched);
    return { mark: 'clear', stop: false };
  } catch (error) {
    return failure(env, row.subject, touched, error);
  }
}

async function plan(env: RunEnv, subject: string, touched: Touched): Promise<void> {
  const { ctx, rpc, runId, dry } = env;
  const db = ctx.env.DB;
  const desired = await desiredState(db, subject, ctx.clock.now());
  const who: Who = { subject, userId: desired.userId };
  touched.targets = targetKeys(desired);
  if (desired.skip === 'platform_admin') return;
  const lookup = await rpc.lookup(subject);
  if (lookup.isAdmin) return;

  const states = new Map((await statesOfSubject(db, subject)).map((s) => [s.target, s]));
  const open = await openDriftOfSubject(db, subject);
  const wantsNothing = desired.skip === 'disabled';
  const present = new Set(lookup.roles.filter(isManaged));
  const grants = new Set(lookup.grants);
  const everyTarget = new Set<Target>([
    ...desired.targets.keys(),
    ...present,
    ...grants,
    ...states.keys(),
  ]);

  let account: 'ready' | 'would' | 'no' = 'ready';
  if (lookup.disabled && !wantsNothing) account = await enable(env, who, lookup.class);

  const adds: Target[] = [];
  const removes: Target[] = [];
  for (const target of [...everyTarget].sort()) {
    const s = states.get(target);
    const facts = {
      present: present.has(target),
      grant: grants.has(target),
      wanted: !wantsNothing && desired.targets.has(target),
      held: s?.held_at != null,
      seen: s?.observed === 1,
    };
    const presence = presenceOf(facts);
    switch (classify(facts)) {
      case 'ok':
        await observeTarget(ctx, who, target, { present: true, presence }, s);
        await closeDrift(ctx, who, target, open, ['missing', 'unexpected', 'apply_failed'], 'ok');
        break;
      case 'external':
        await observeTarget(ctx, who, target, { present: true, presence }, s);
        await noteDrift(ctx, runId, who, target, 'external_added', open);
        await closeDrift(ctx, who, target, open, ['missing', 'unexpected'], 'external');
        break;
      case 'none':
      case 'held':
        await observeTarget(ctx, who, target, { present: false, presence: 'none' }, s);
        await closeDrift(ctx, who, target, open, ['missing', 'unexpected'], 'gone');
        break;
      case 'hold':
        if (dry) await noteDrift(ctx, runId, who, target, 'owner_removed', open);
        else await holdTargetForOwner(ctx, runId, who, target);
        break;
      case 'add':
        if (env.blocked.has(target)) await failTarget(ctx, who, target, 'IDP_BLOCKED');
        else if (account === 'would') await noteDrift(ctx, runId, who, target, 'missing', open);
        else if (account === 'no')
          await noteDrift(ctx, runId, who, target, 'disabled_in_idp', open);
        else adds.push(target);
        break;
      case 'remove':
      case 'settle':
        if (env.blocked.has(target)) await failTarget(ctx, who, target, 'IDP_BLOCKED');
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
  if (!dry) await settleSponsorships(ctx, who);
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
        await failTarget(env.ctx, who, target, 'IDP_REFUSED');
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
