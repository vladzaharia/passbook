import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { liveSponsorsOfUser } from '../dev-access/repo-sponsors.ts';
import { progressOf } from '../operations/progress.ts';
import { getUser } from '../users/repo.ts';
import { idpClient } from './client.ts';
import { drainSubject } from './drain.ts';
import { openGate } from './jobs.ts';
import { adminStill, held, notReady, takeSync } from './ops-runs.ts';
import { clearDirty, dirtyOf, failDirty, markDirty } from './repo-dirty.ts';
import { dropLease, renewLease, SYNC_LEASE } from './repo-lease.ts';
import { activePlatformGrants } from './repo-role-grants.ts';
import { subjectsOfUser } from './repo-sources.ts';
import { statesOfUser } from './repo-state.ts';
import type { RunEnv } from './run-env.ts';

/**
 * Offboard's second half. The request ended PassBook access and disabled the user; this checks that stuck, brings
 * each of their Polaris ID accounts to its desired state (nothing) under the sync lease, and reads the roles back.
 * Roles added in Polaris ID are reported, never removed here.
 */
export async function offboardRun(
  ctx: ServiceContext,
  op: OperationDto,
  lease: string,
): Promise<void> {
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  const db = ctx.env.DB;
  await adminStill(ctx, op);
  const userId = op.target?.id;
  if (!userId) throw new AppError('IDP_OFFBOARD_INCOMPLETE', 409, 'No user to offboard.');
  progress.step('revoke');
  const user = await getUser(db, userId);
  if (
    user?.status !== 'disabled' ||
    (await liveSponsorsOfUser(db, userId)).length > 0 ||
    (await activePlatformGrants(db, userId)).length > 0
  )
    throw new AppError('IDP_OFFBOARD_INCOMPLETE', 409, 'PassBook access did not end.');
  await progress.step('revoke').done();
  const subjects = await subjectsOfUser(db, userId);
  if (subjects.length === 0) {
    await progress.step('sync').skip();
    await progress.step('confirm').skip();
    await progress.succeed({ href: null, ids: { external: '0' } });
    return;
  }
  for (const subject of subjects) await markDirty(db, subject);
  progress.step('sync');
  const holder = await takeSync(ctx, op, progress, 'sync', lease);
  if (!holder) return;
  try {
    const rpc = idpClient(ctx.env, ctx.log);
    const gate = await openGate(ctx, rpc, 'idp.offboard');
    if (!gate) throw notReady();
    if (gate.dry) {
      await progress.step('sync').skip();
      await progress.step('confirm').skip();
      await progress.succeed({ href: null, ids: { external: '0', dryRun: 'yes' } });
      return;
    }
    const env: RunEnv = {
      ctx,
      rpc,
      runId: ctx.ids.id(),
      ...gate,
      renew: async () => void (await renewLease(db, SYNC_LEASE, holder, ctx.clock.now())),
    };
    for (const subject of subjects) {
      const mark = await dirtyOf(db, subject);
      if (!mark) continue;
      await held(ctx, op, lease);
      const outcome = await drainSubject(env, mark);
      if (outcome.mark === 'clear') await clearDirty(db, subject, mark.version);
      else if (outcome.mark === 'fail') await failDirty(db, subject, mark.version, ctx.clock.now());
      if (outcome.mark === 'fail')
        throw new AppError('IDP_APPLY_FAILED', 502, 'Polaris ID did not accept the change.');
      if (outcome.stop) throw notReady();
    }
    await progress.step('sync').done();
    progress.step('confirm');
    const states = await statesOfUser(db, userId);
    if (states.some((s) => s.observed === 1 && s.presence === 'passbook'))
      throw new AppError('IDP_NOT_APPLIED', 502, 'Polaris ID did not remove a role.');
    const external = states.filter((s) => s.observed === 1 && s.presence === 'external').length;
    await progress.step('confirm').done();
    await progress.succeed({ href: null, ids: { external: String(external) } });
  } finally {
    await dropLease(db, SYNC_LEASE, holder);
  }
}
