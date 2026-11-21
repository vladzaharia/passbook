import type { BulkRunDto } from '../../../shared/contracts/pass-bulk-runs.ts';
import type { PassFilter } from '../../../shared/contracts/pass-selection.ts';
import { ConflictError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { dropPages, finish, PAGE, pageKey } from './bulk-run-core.ts';
import { bulkRunDto } from './bulk-run-dto.ts';
import { resolveFilterPasses } from './find.ts';
import type { TenantPassWrite } from './http.ts';
import { reissuePrincipalOf } from './repo-bulk-principal.ts';
import {
  ACTIVE_STATES,
  type BulkRunRecord,
  deleteEndedBefore,
  insertRun,
  latestRun,
  lockHeld,
  readRun,
  releaseLock,
  requestStop,
  saveRun,
  stalledRuns,
  takeLock,
} from './repo-bulk-runs.ts';
import type { Actor } from './service.ts';

const LOCK_STALE = 30 * 60_000;
const STALLED_AFTER = 10 * 60_000;
const KEEP_ENDED = 7 * 86_400_000;

export const bulkInstanceId = (runId: string) => `bulkact-${runId}`;

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
