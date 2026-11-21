import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { actorOfStarter } from '../delivery/delivery-actor.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { actorOf, finish, PAGE, pageKey } from './bulk-run-core.ts';
import type { RunWrite } from './bulk-write.ts';
import { resendEmail } from './pass-service-delivery.ts';
import { removePass } from './remove.ts';
import {
  reissuePrincipalCheck,
  reissuePrincipalSql,
  reissuePrincipalValid,
} from './repo-bulk-principal.ts';
import {
  ACTIVE_STATES,
  type BulkRunRecord,
  holdsLock,
  mailQueuedForRun,
  readRun,
  saveRun,
  stopFlag,
  touchLock,
} from './repo-bulk-runs.ts';
import { getPass } from './repo-read-pass.ts';
import { getRemoval } from './repo-remove.ts';
import { voidPass } from './service.ts';

/** Passes per workflow step. */
export const BULK_RUN_CHUNK = 25;

/**
 * One pass of the run. Each write proves the starter inside its own grant, after a read proof just
 * before it. Void and remove are also pinned to the version the snapshot saw, in the write itself;
 * email skips a pass that moved. `proof` is the starter's in-grant check.
 */
async function applyOne(
  ctx: ServiceContext,
  rec: BulkRunRecord,
  passId: string,
  seen: number,
): Promise<'done' | string> {
  const scope = { orgId: rec.orgId, mode: rec.mode, principal: 'session' as const };
  const pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass || pass.orgId !== rec.orgId || pass.mode !== rec.mode) return 'PASS_NOT_FOUND';
  const actor = actorOf(rec.starter);
  const now = ctx.clock.now();
  const write: RunWrite = {
    checks: [reissuePrincipalCheck(rec.orgId, rec.starter, now)],
    version: seen,
    runId: rec.id,
  };
  try {
    if (rec.action === 'send_email') {
      if (pass.removedAt !== null) return 'PASS_REMOVED';
      if (pass.status !== 'active') return 'NOT_ACTIVE';
      if (pass.version !== seen) return 'PASS_CHANGED';
      if (!pass.holderEmail) return 'NO_RECIPIENT';
      // Queued by an earlier try of this step (crash before the cursor moved): never a second mail.
      if (await mailQueuedForRun(ctx.env.DB, passId, rec.id)) return 'done';
      // The queueing grant proves the starter; the starter is a reviewed site for a deferred actor (a workflow, no request).
      await resendEmail(
        ctx,
        actor,
        passId,
        {},
        scope,
        undefined,
        [actorOfStarter(rec.starter, rec.orgId, rec.mode)],
        rec.id,
      );
      return 'done';
    }
    if (rec.action === 'void') {
      if (pass.removedAt !== null) return 'PASS_REMOVED';
      if (pass.status === 'voided') return 'done';
      if (pass.status !== 'active') return 'NOT_ACTIVE';
      await voidPass(ctx, actor, passId, scope, undefined, write);
      return 'done';
    }
    if (pass.removedAt !== null) {
      // A claim without its publish (a crash between the two) resumes; only a published removal is done.
      const removal = await getRemoval(ctx.env.DB, passId);
      if (removal && removal.publishedGeneration === removal.generation && pass.status === 'voided')
        return 'done';
    } else if (pass.version !== seen) return 'PASS_CHANGED';
    await removePass(
      ctx,
      actor,
      passId,
      { message: rec.message ?? undefined },
      scope,
      undefined,
      {
        version: seen,
        noScans: false,
        proof: reissuePrincipalSql(rec.orgId, rec.starter, now),
      },
      undefined,
      write.checks,
      rec.id,
    );
    return 'done';
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // A refusal from a revoked starter ends the run in the caller's next proof.
    return error.code === 'IMPORT_PASS_CHANGED' ? 'PASS_CHANGED' : error.code;
  }
}

/** One workflow step: up to BULK_RUN_CHUNK passes from the run's cursor. `more` is false once it ended. */
export async function runBulkChunk(ctx: ServiceContext, runId: string): Promise<{ more: boolean }> {
  let rec = await readRun(ctx.env.DB, runId);
  if (!rec || !ACTIVE_STATES.includes(rec.state)) return { more: false };
  // A run whose lock went to another run (a takeover of a stale one) must not go on beside it.
  if (!(await holdsLock(ctx.env.DB, rec.orgId, rec.mode, rec.id))) {
    await finish(ctx, rec, 'failed', 'BULK_RUN_SUPERSEDED');
    return { more: false };
  }
  rec = { ...rec, state: 'running' };
  const pages = new Map<number, [string, number][]>();
  const end = Math.min(rec.total, rec.cursor + BULK_RUN_CHUNK);
  let pushes = false;
  while (rec.cursor < end) {
    // Stop and the starter's rights are read before every pass.
    if (await stopFlag(ctx.env.DB, rec.id)) {
      await finish(ctx, rec, 'stopped', 'BULK_RUN_STOPPED');
      if (pushes) await dispatchSafely(ctx);
      return { more: false };
    }
    if (!(await reissuePrincipalValid(ctx.env.DB, rec.orgId, rec.starter, ctx.clock.now()))) {
      ctx.log.warn('passes.bulk_run_principal_revoked', {
        orgId: rec.orgId,
        code: 'BULK_RUN_PRINCIPAL_REVOKED',
      });
      await finish(ctx, rec, 'failed', 'BULK_RUN_PRINCIPAL_REVOKED');
      if (pushes) await dispatchSafely(ctx);
      return { more: false };
    }
    const n = Math.floor(rec.cursor / PAGE);
    let page = pages.get(n);
    if (!page) {
      const object = await ctx.env.BUCKET.get(pageKey(rec, n));
      if (!object) {
        await finish(ctx, rec, 'failed', 'BULK_RUN_LOST');
        return { more: false };
      }
      page = (await object.json()) as [string, number][];
      pages.set(n, page);
    }
    const item = page[rec.cursor % PAGE];
    if (!item) {
      // The page is shorter than the run says: it cannot finish.
      await finish(ctx, rec, 'failed', 'BULK_RUN_LOST');
      if (pushes) await dispatchSafely(ctx);
      return { more: false };
    }
    const result = await applyOne(ctx, rec, item[0], item[1]);
    if (result === 'done') {
      rec.done += 1;
      if (rec.action !== 'send_email') pushes = true;
    } else {
      rec.skipped += 1;
      rec.skippedBy = { ...rec.skippedBy, [result]: (rec.skippedBy[result] ?? 0) + 1 };
    }
    rec.cursor += 1;
    // Mail cannot be recalled: the cursor moves with each queued mail, so a retried step never sends it twice.
    if (rec.action === 'send_email') {
      rec.updatedAt = ctx.clock.now();
      if (!(await saveRun(ctx.env.DB, rec))) return { more: false };
    }
  }
  rec.updatedAt = ctx.clock.now();
  if (!(await saveRun(ctx.env.DB, rec))) return { more: false };
  await touchLock(ctx.env.DB, rec.orgId, rec.mode, rec.id, rec.updatedAt);
  // One dispatch per chunk, as bulk reissue does.
  if (pushes) await dispatchSafely(ctx);
  if (rec.cursor >= rec.total) {
    await finish(ctx, rec, 'done', null);
    return { more: false };
  }
  return { more: true };
}
