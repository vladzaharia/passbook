import { ConflictError, NotFoundError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { removePassFromUser } from '../holders/service-remove.ts';
import { requestRefresh } from '../passes/pass-service-refresh.ts';
import { FIRST_CHECK_S, sendWaitCheck, waitOnWallets } from './operations.ts';
import { activeHolderOperation, startHolderOperation } from './operations-start.ts';
import * as repo from './repo.ts';
import { ownedRow } from './service.ts';

/** Seams from other modules, injectable for tests. */
export interface MeDeps {
  requestRefresh: typeof requestRefresh;
  removePassFromUser: typeof removePassFromUser;
}
const defaultDeps: MeDeps = { requestRefresh, removePassFromUser };

export async function refreshMyPass(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  passId: string,
  deps: MeDeps = defaultDeps,
) {
  const who = { userId, sessionId };
  const row = await ownedRow(ctx, userId, passId);
  if (row.status === 'voided') throw new ConflictError('This pass is voided.', 'PASS_VOIDED');
  if (!(await checkRateLimit(ctx.env, 'RL_REFRESH', `refresh:${passId}`))) {
    throw new RateLimitedError();
  }
  let operationId: string | undefined;
  const { requestedAt, cooldownSeconds } = await deps.requestRefresh(
    ctx,
    passId,
    { type: 'user', id: userId },
    {
      orgId: row.org_id,
      mode: row.mode,
      identityId: row.identity_id,
      templateId: row.template_id,
      templateVersion: row.template_version,
      releaseId: row.release_id,
      version: row.version,
      credentialGeneration: row.credential_generation,
      lifecycleGeneration: row.lifecycle_generation,
      linkGeneration: row.link_generation,
      status: row.status,
      connectionId: row.connection_id,
      externalRef: row.external_ref,
      ownerUserId: userId,
    },
    undefined,
    {
      onClaimed: async () => {
        // A refresh still running on this pass is the one this click joins: its job carries the id.
        // On another device's, quietly: this click starts nothing and names nothing.
        const running = await activeHolderOperation(ctx, who, 'holder.refresh', passId);
        operationId = running.id ?? undefined;
        if (running.running) return undefined;
        const op = await startHolderOperation(ctx, who, 'holder.refresh', passId);
        await op.progress.step('check').done();
        operationId = op.id;
        return op.id;
      },
    },
  );
  // Inside the cooldown nothing new starts: the earlier refresh's operation, if it still runs.
  operationId ??= (await activeHolderOperation(ctx, who, 'holder.refresh', passId)).id ?? undefined;
  return {
    accepted: true as const,
    requestedAt,
    cooldownSeconds,
    ...(operationId ? { operationId } : {}),
  };
}

/** The pass as the holder saw it: the transfer refuses if it moved since. */
export const sourceOf = (userId: string, row: repo.MyPassRow) => ({
  orgId: row.org_id,
  mode: row.mode,
  holderEmail: row.holder_email,
  ownerUserId: userId,
  version: row.version,
  revision: row.revision,
  rowVersion: row.row_version,
  credentialGeneration: row.credential_generation,
  lifecycleGeneration: row.lifecycle_generation,
  releaseId: row.release_id,
  downloadToken: row.download_token,
  linkGeneration: row.link_generation,
});

export async function removeMyPass(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  passId: string,
  deps: MeDeps = defaultDeps,
) {
  const row = await repo.getPassForRemoval(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const who = { userId, sessionId };
  const result = await deps.removePassFromUser(
    ctx,
    passId,
    userId,
    sessionId,
    sourceOf(userId, row),
  );
  const op = await startHolderOperation(ctx, who, 'holder.remove', passId);
  await op.progress.step('account').done();
  if (result.state === 'completed') {
    await op.progress.step('wallets').skip();
    await op.progress.succeed();
  } else {
    // The look is queued before the wait is written: a failed send leaves no wait nobody will end.
    try {
      await sendWaitCheck(ctx, op.id, 1, FIRST_CHECK_S);
    } catch (error) {
      await op.progress.fail(error);
      throw error;
    }
    await waitOnWallets(op.progress, ctx.clock.now());
  }
  return { ...result, operationId: op.id };
}

export async function getMyRemoval(ctx: ServiceContext, userId: string, transferId: string) {
  const transfer = await repo.getMyRemoval(ctx.env.DB, userId, transferId);
  if (!transfer) throw new NotFoundError('Removal not found.', 'REMOVAL_NOT_FOUND');
  return transfer;
}
