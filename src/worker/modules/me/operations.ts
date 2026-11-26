import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { hasPendingIssuanceTransfer } from '../delivery/repo-issuance-recovery.ts';
import { progressOf } from '../operations/progress.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { releaseLease } from '../operations/repo.ts';

/** The first look at a removal comes this soon after it starts. */
export const FIRST_CHECK_S = 30;
const MIN_DELAY_S = FIRST_CHECK_S;
const MAX_DELAY_S = 900;

/** Queues the next look at a removal: `operation.run` after `delaySeconds`. */
export const sendRemovalCheck = (
  ctx: ServiceContext,
  operationId: string,
  attempt: number,
  delaySeconds: number,
) => ctx.env.JOBS.send({ kind: 'operation.run', operationId, attempt }, { delaySeconds });

/** A quarter of the time waited so far, between 30 s and 15 min: a removal can take hours. */
const delayAfter = (waitedMs: number) =>
  Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.floor(waitedMs / 4000)));

/**
 * A removal is done when no wallet credential transfer is pending on the pass. Until then it waits and
 * looks again through a delayed `operation.run`, never inside one request.
 */
const removal: NonNullable<OperationRunner['run']> = async (ctx, op, lease) => {
  const passId = op.target?.id;
  if (!passId) throw new AppError('PASS_NOT_FOUND', 404, 'Pass not found.');
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  if (await hasPendingIssuanceTransfer(ctx.env.DB, passId)) {
    await progress.waiting('wallets', { reason: 'Waiting for your wallets' });
    await releaseLease(ctx.env.DB, op.id, op.attempt, lease);
    await sendRemovalCheck(ctx, op.id, op.attempt, delayAfter(ctx.clock.now() - op.createdAt));
    return;
  }
  await progress.step('wallets').done();
  await progress.succeed();
};

export const operationRunners: OperationRunners = {
  'holder.remove': { run: removal },
};
