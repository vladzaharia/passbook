import type { ServiceContext } from '../../platform/service-context.ts';
import type { VersionRow } from '../templates/repo.ts';
import { getVersion } from '../templates/repo.ts';
import type { ProjectionV2 } from './projection-contract.ts';
import { pipelineAddsLoss, pipelineRevision } from './projection-pins.ts';
import type { ApprovedProjection } from './projection-service-support.ts';
import { getPauseCheck, putPauseCheck } from './repo-projection-art.ts';

type Probe = (ctx: ServiceContext, pinned: ProjectionV2, version: VersionRow) => Promise<boolean>;
let probe: Probe = pipelineAddsLoss;

/** Tests only: replaces the check that recompiles under the current pipeline; returns a restorer. */
export function setPauseProbeForTest(replacement: Probe): () => void {
  const previous = probe;
  probe = replacement;
  return () => {
    probe = previous;
  };
}

/**
 * Q21, for the offer paths only. A schema 2 release whose pipeline changed since approval pauses
 * new offers when the change adds a loss; the answer is memoized per (candidate, pipeline) so a
 * page view does not recompile. Anything that goes wrong counts as paused and is logged: this
 * check never throws into a holder's page, `/me`, sync or scheduling.
 */
export async function offersPaused(
  ctx: ServiceContext,
  approved: ApprovedProjection,
): Promise<boolean> {
  const pinned = approved.projection;
  if (pinned.schema !== 2) return false;
  try {
    const pipeline = await pipelineRevision(pinned.provider);
    if (pinned.pipeline === pipeline) return false;
    const candidateId = approved.release.candidateId;
    if (!candidateId) return true;
    const memo = await getPauseCheck(ctx.env.DB, candidateId, pipeline);
    if (memo !== null) return memo;
    const version = await getVersion(
      ctx.env.DB,
      approved.release.templateId,
      approved.release.version,
    );
    const paused = version ? await probe(ctx, pinned, version) : true;
    await putPauseCheck(ctx.env.DB, { candidateId, pipeline, paused, now: ctx.clock.now() });
    return paused;
  } catch (error) {
    ctx.log.warn('wallet.offer_pause_check_failed', { code: 'WALLET_OFFER_PAUSE_CHECK', error });
    return true;
  }
}
