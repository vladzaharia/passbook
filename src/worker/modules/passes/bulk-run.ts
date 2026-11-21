import type { BulkRunDto } from '../../../shared/contracts/pass-bulk-runs.ts';
import type { PassFilter } from '../../../shared/contracts/pass-selection.ts';
import { AppError, ConflictError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { actorOfStarter } from '../delivery/delivery-actor.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { bulkRunDto } from './bulk-run-dto.ts';
import type { RunWrite } from './bulk-write.ts';
import { resolveFilterPasses } from './find.ts';
import type { TenantPassWrite } from './http.ts';
import { resendEmail } from './pass-service-delivery.ts';
import { removePass } from './remove.ts';
import {
  type DeferredStarter,
  reissuePrincipalCheck,
  reissuePrincipalOf,
  reissuePrincipalSql,
  reissuePrincipalValid,
} from './repo-bulk-principal.ts';
import {
  ACTIVE_STATES,
  type BulkRunRecord,
  type BulkRunState,
  deleteEndedBefore,
  holdsLock,
  insertRun,
  latestRun,
  lockHeld,
  readRun,
  releaseLock,
  requestStop,
  saveRun,
  stalledRuns,
  stopFlag,
  takeLock,
  touchLock,
} from './repo-bulk-runs.ts';
import { getPass } from './repo-read-pass.ts';
import { getRemoval } from './repo-remove.ts';
import { type Actor, voidPass } from './service.ts';

/** Ids per R2 page, and passes per workflow step. */
const PAGE = 500;
export const BULK_RUN_CHUNK = 25;
const LOCK_STALE = 30 * 60_000;
const STALLED_AFTER = 10 * 60_000;
const KEEP_ENDED = 7 * 86_400_000;

const pageKey = (r: Pick<BulkRunRecord, 'orgId' | 'id'>, n: number) =>
  `bulk-runs/${r.orgId}/${r.id}/${n}.json`;

export const bulkInstanceId = (runId: string) => `bulkact-${runId}`;

const actorOf = (s: DeferredStarter): Actor =>
  s.kind === 'membership' ? { type: 'user', id: s.userId } : { type: 'api_key', id: s.keyId };

async function dropPages(ctx: ServiceContext, rec: BulkRunRecord): Promise<void> {
  for (let n = 0; n * PAGE < rec.total; n++) await ctx.env.BUCKET.delete(pageKey(rec, n));
}

/**
 * Starts a bulk action over every pass a filter matches. The matching ids and versions are fixed here,
 * after the count check, so passes issued later never join. The starter's identity and revisions are
 * captured; the run proves them again before each pass.
 */
export async function startBulkRun(
  ctx: ServiceContext,
  actor: Actor,
  input: {
    authority: TenantPassWrite;
    mode: 'live' | 'test';
    action: BulkRunRecord['action'];
    message?: string | undefined;
    filter: PassFilter;
    expectCount: number;
  },
): Promise<BulkRunDto> {
  const { authority, mode } = input;
  const orgId = authority.orgId;
  const starter = await reissuePrincipalOf(ctx.env.DB, authority, undefined);
  if (!starter || starter.kind === 'platform') throw new NotFoundError('Organization not found.');
  const busy = () =>
    new ConflictError(
      'A bulk run is already going for this organization. Wait for it to finish.',
      'BULK_RUN_ACTIVE',
    );
  // A cheap read first: a locked org does not pay for the scan.
  if (await lockHeld(ctx.env.DB, orgId, mode, ctx.clock.now() - LOCK_STALE)) throw busy();
  const passes = await resolveFilterPasses(
    ctx,
    { orgId, mode },
    input.filter,
    input.expectCount,
    false,
  );
  const id = ctx.ids.id();
  const now = ctx.clock.now();
  if (!(await takeLock(ctx.env.DB, orgId, mode, id, now, now - LOCK_STALE))) throw busy();
  const rec: BulkRunRecord = {
    id,
    orgId,
    mode,
    action: input.action,
    message: input.message ?? null,
    state: 'queued',
    total: passes.length,
    cursor: 0,
    done: 0,
    skipped: 0,
    skippedBy: {},
    starter,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    code: null,
  };
  let inserted = false;
  try {
    for (let n = 0; n * PAGE < passes.length; n++)
      await ctx.env.BUCKET.put(
        pageKey(rec, n),
        JSON.stringify(passes.slice(n * PAGE, (n + 1) * PAGE).map((p) => [p.id, p.version])),
      );
    await insertRun(ctx.env.DB, rec);
    inserted = true;
    await ctx.env.BULK_REISSUE.create({
      id: bulkInstanceId(id),
      params: { kind: 'bulk_action', runId: id },
    });
  } catch (error) {
    ctx.log.error('passes.bulk_run_start_failed', { orgId, code: 'BULK_RUN_START', error });
    // A row that was written must not linger as a queued run nobody will start.
    if (inserted)
      await saveRun(ctx.env.DB, {
        ...rec,
        state: 'failed',
        code: 'BULK_RUN_START',
        finishedAt: ctx.clock.now(),
        updatedAt: ctx.clock.now(),
      });
    await releaseLock(ctx.env.DB, orgId, mode, id);
    await dropPages(ctx, rec);
    throw new UnavailableError('The run did not start. Try again.', 'BULK_RUN_START');
  }
  await recordAudit(ctx, {
    orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.bulk_run',
    targetType: 'org',
    targetId: orgId,
    // The filter says which passes the run covered; a holder address in it is not recorded.
    detail: {
      runId: id,
      action: input.action,
      total: rec.total,
      filter: { ...input.filter, ...(input.filter.holderEmail ? { holderEmail: '[hidden]' } : {}) },
    },
  });
  return bulkRunDto(rec, false);
}

/** What the list shows on load: a running run, or one that ended within the hour. */
export async function currentBulkRun(
  ctx: ServiceContext,
  orgId: string,
  mode: 'live' | 'test',
): Promise<BulkRunDto | null> {
  const rec = await latestRun(ctx.env.DB, orgId, mode);
  const recent =
    rec &&
    (ACTIVE_STATES.includes(rec.state) || (rec.finishedAt ?? 0) > ctx.clock.now() - 3_600_000);
  return rec && recent ? bulkRunDto(rec, rec.stopRequested) : null;
}

export async function getBulkRun(
  ctx: ServiceContext,
  id: string,
  orgId: string,
  mode: 'live' | 'test',
): Promise<BulkRunDto> {
  const rec = await readRun(ctx.env.DB, id);
  if (!rec || rec.orgId !== orgId || rec.mode !== mode)
    throw new NotFoundError('Run not found.', 'BULK_RUN_NOT_FOUND');
  return bulkRunDto(rec, rec.stopRequested);
}

/** Asks a running run to stop after its current chunk. */
export async function stopBulkRun(
  ctx: ServiceContext,
  id: string,
  orgId: string,
  mode: 'live' | 'test',
): Promise<BulkRunDto> {
  const rec = await readRun(ctx.env.DB, id);
  if (!rec || rec.orgId !== orgId || rec.mode !== mode)
    throw new NotFoundError('Run not found.', 'BULK_RUN_NOT_FOUND');
  if (!(await requestStop(ctx.env.DB, id)))
    throw new ConflictError('The run has ended.', 'BULK_RUN_ENDED');
  return bulkRunDto(rec, true);
}

async function finish(
  ctx: ServiceContext,
  rec: BulkRunRecord,
  state: Exclude<BulkRunState, 'queued' | 'running'>,
  code: string | null,
): Promise<void> {
  const now = ctx.clock.now();
  const ended = { ...rec, state, code, finishedAt: now, updatedAt: now };
  // The write only lands while the run is still active, so a swept run is not revived.
  if (await saveRun(ctx.env.DB, ended)) {
    await releaseLock(ctx.env.DB, rec.orgId, rec.mode, rec.id);
    await dropPages(ctx, rec);
    ctx.log.info('passes.bulk_run_ended', {
      orgId: rec.orgId,
      runId: rec.id,
      state,
      done: rec.done,
      skipped: rec.skipped,
      ...(code ? { code } : {}),
    });
  }
}

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

/** A workflow that gave up (exhausted retries) ends its run as failed. */
export async function failBulkRun(ctx: ServiceContext, runId: string, code: string): Promise<void> {
  const rec = await readRun(ctx.env.DB, runId);
  if (rec && ACTIVE_STATES.includes(rec.state)) await finish(ctx, rec, 'failed', code);
}

/** Frees runs that stopped moving (a dead workflow) and deletes ended ones after a week. */
export async function sweepBulkRuns(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  for (const rec of await stalledRuns(ctx.env.DB, now - STALLED_AFTER, 50)) {
    await finish(ctx, rec, 'failed', 'BULK_RUN_STALLED');
    ctx.log.warn('passes.bulk_run_swept', {
      orgId: rec.orgId,
      runId: rec.id,
      code: 'BULK_RUN_STALLED',
    });
  }
  await deleteEndedBefore(ctx.env.DB, now - KEEP_ENDED);
}
