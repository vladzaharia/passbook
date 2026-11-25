import type { ServiceContext } from '../../platform/service-context.ts';
import type { VersionRow } from '../templates/repo.ts';
import { getVersion } from '../templates/repo.ts';
import type { ProjectionV2 } from './projection-contract.ts';
import { pipelineAddsLoss } from './projection-pins.ts';
import { pipelineRevision } from './projection-pipeline.ts';
import type { ApprovedProjection } from './projection-service-support.ts';
import { getPauseCheck, putPauseCheck } from './repo-projection-art.ts';

type Probe = (
  ctx: ServiceContext,
  pinned: ProjectionV2,
  version: VersionRow,
  orgId?: string,
) => Promise<boolean>;
let probe: Probe = pipelineAddsLoss;

/** Tests only: replaces the check that recompiles under the current pipeline; returns a restorer. */
export function setPauseProbeForTest(replacement: Probe): () => void {
  const previous = probe;
  probe = replacement;
  return () => {
    probe = previous;
  };
}

/** A failed check is not memoized in D1, but a request storm must not recompile for each call. */
const FAILURE_TTL_MS = 60_000;
const failedUntil = new Map<string, number>();
const inflight = new Map<string, Promise<boolean>>();

/**
 * Q21, for the offer paths only. A schema 2 release whose pipeline changed since approval pauses
 * new offers when the change adds a loss; the answer is memoized per (candidate, pipeline) so a
 * page view does not recompile. Anything that goes wrong counts as paused and is logged: this
 * check never throws into a holder's page, `/me`, sync or scheduling. A failure is remembered for
 * a minute in this isolate, and concurrent callers share one computation.
 */
export async function offersPaused(
  ctx: ServiceContext,
  approved: ApprovedProjection,
): Promise<boolean> {
  const pinned = approved.projection;
  if (pinned.schema !== 2) return false;
  const candidateId = approved.release.candidateId;
  try {
    const pipeline = await pipelineRevision(pinned.provider);
    if (pinned.pipeline === pipeline) return false;
    if (!candidateId) return true;
    const key = `${candidateId}:${pipeline}`;
    const memo = await getPauseCheck(ctx.env.DB, candidateId, pipeline);
    if (memo !== null) return memo;
    if ((failedUntil.get(key) ?? 0) > ctx.clock.now()) return true;
    let running = inflight.get(key);
    if (!running) {
      running = compute(ctx, approved, pinned, candidateId, pipeline, key).finally(() =>
        inflight.delete(key),
      );
      inflight.set(key, running);
    }
    return await running;
  } catch (error) {
    ctx.log.error('wallet.offer_pause_check_failed', { code: 'WALLET_OFFER_PAUSE_CHECK', error });
    return true;
  }
}

async function compute(
  ctx: ServiceContext,
  approved: ApprovedProjection,
  pinned: ProjectionV2,
  candidateId: string,
  pipeline: string,
  key: string,
): Promise<boolean> {
  try {
    const version = await getVersion(
      ctx.env.DB,
      approved.release.templateId,
      approved.release.version,
    );
    const paused = version
      ? await probe(ctx, pinned, version, approved.release.orgId ?? undefined)
      : true;
    await putPauseCheck(ctx.env.DB, { candidateId, pipeline, paused, now: ctx.clock.now() });
    return paused;
  } catch (error) {
    failedUntil.set(key, ctx.clock.now() + FAILURE_TTL_MS);
    throw error;
  }
}
