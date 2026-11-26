import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { hasPendingIssuanceTransfer } from '../delivery/repo-issuance-recovery.ts';
import { progressOf } from '../operations/progress.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { releaseLease } from '../operations/repo.ts';
import { hasPendingOwnRemoval } from './repo.ts';

/** The first look comes this soon after the start. */
export const FIRST_CHECK_S = 30;
const MAX_DELAY_S = 900;
/** No wait runs longer: past this the operation ends failed and says what to do. */
export const WAIT_CAP_MS = 24 * 3_600_000;

/** Queues the next look: `operation.run` after `delaySeconds`. */
export const sendWaitCheck = (
  ctx: ServiceContext,
  operationId: string,
  attempt: number,
  delaySeconds: number,
) => ctx.env.JOBS.send({ kind: 'operation.run', operationId, attempt }, { delaySeconds });

/** A quarter of the time waited so far, between 30 s and 15 min: wallets can take hours. */
const delayAfter = (waitedMs: number) =>
  Math.min(MAX_DELAY_S, Math.max(FIRST_CHECK_S, Math.floor(waitedMs / 4000)));

/**
 * The wallets step waits as a timed wait that ends at the cap, so the stall sweep sees a look that was lost:
 * past the cap it resends once, and the next look fails the operation.
 */
export const waitOnWallets = (
  progress: ReturnType<typeof progressOf>,
  createdAt: number,
): Promise<void> =>
  progress.waiting('wallets', {
    reason: 'Waiting for your wallets',
    due: true,
    until: createdAt + WAIT_CAP_MS,
  });

/**
 * One look at a wait: `settled` ends it; otherwise it waits again and looks later through a delayed
 * `operation.run`, never inside one request, and past the cap it fails.
 */
async function look(
  ctx: ServiceContext,
  op: Parameters<NonNullable<OperationRunner['run']>>[1],
  lease: string,
  pending: boolean,
  onSettled: (progress: ReturnType<typeof progressOf>) => Promise<void>,
): Promise<void> {
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  const waited = ctx.clock.now() - op.createdAt;
  if (!pending) return onSettled(progress);
  if (waited >= WAIT_CAP_MS) {
    await progress.fail(
      new AppError('HOLDER_TRANSFER_PENDING', 409, 'The wallets have not let go yet.'),
    );
    return;
  }
  await waitOnWallets(progress, op.createdAt);
  await releaseLease(ctx.env.DB, op.id, op.attempt, lease);
  await sendWaitCheck(ctx, op.id, op.attempt, delayAfter(waited));
}

const passOf = (op: { target: { id: string } | null }): string => {
  if (!op.target) throw new AppError('PASS_NOT_FOUND', 404, 'Pass not found.');
  return op.target.id;
};

/** A removal is done when its own wallet transfer is: another person's later transfer on the pass is not its wait. */
const removal: NonNullable<OperationRunner['run']> = async (ctx, op, lease) => {
  const pending = await hasPendingOwnRemoval(
    ctx.env.DB,
    passOf(op),
    op.startedBy.id ?? '',
    op.createdAt,
  );
  await look(ctx, op, lease, pending, async (progress) => {
    await progress.step('wallets').done();
    await progress.succeed();
  });
};

/**
 * A lost phone sends the new pass once the old credentials are retired. This runner waits for that, then queues
 * the mail; the mail job no longer waits on queue retries.
 */
const lostPhone: NonNullable<OperationRunner['run']> = async (ctx, op, lease) => {
  const passId = passOf(op);
  const pending = await hasPendingIssuanceTransfer(ctx.env.DB, passId);
  await look(ctx, op, lease, pending, async (progress) => {
    // The mail is queued, running or done already (a resent look): nothing to send twice.
    if (op.steps.some((s) => s.key === 'mail' && s.state !== 'pending')) return;
    await progress.step('wallets').done();
    // The mail job reports for it next, without this look's lease.
    await releaseLease(ctx.env.DB, op.id, op.attempt, lease);
    await ctx.env.JOBS.send({
      kind: 'pass.holder_mail',
      passId,
      userId: op.startedBy.id,
      reason: 'lost_phone',
      operationId: op.id,
    });
  });
};

export const operationRunners: OperationRunners = {
  'holder.remove': { run: removal },
  'holder.lost_phone': { run: lostPhone },
};
