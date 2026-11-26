import type { Mode } from '../../../shared/contracts/common.ts';
import { bump } from '../../platform/counters.ts';
import { AppError, ConflictError, NotFoundError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { revokeAllForUser } from '../auth/sessions.ts';
import { recipientEmailBudget } from '../delivery/repo-email-budget.ts';
import { rotateOwnPassCredentials } from '../holders/service-rotate.ts';
import { CredentialTransferReissueRequired } from '../passes/credential-transfer.ts';
import { assertNoActiveHolderOperation, startHolderOperation } from './operations-start.ts';
import * as repo from './repo.ts';
import { sourceOf } from './service.ts';

async function ownedActive(ctx: ServiceContext, userId: string, passId: string) {
  const row = await repo.getMyPass(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (row.status === 'voided') throw new ConflictError('This pass is voided.', 'PASS_VOIDED');
  if (!row.holder_email) throw new ConflictError('The pass has no email.', 'NO_RECIPIENT');
  return { row, to: row.holder_email };
}

/** The queued mail would be refused at the recipient cap: say so now, not silently later. */
export async function assertRecipientBudget(ctx: ServiceContext, mode: Mode, to: string) {
  if ((await recipientEmailBudget(ctx.env, mode, to, ctx.clock.now())) === 0)
    throw new AppError(
      'EMAIL_RATE_LIMITED',
      429,
      'Too many emails to this address. Try again in an hour.',
    );
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LOST_PER_PASS_HOUR = 3;
const LOST_PER_USER_DAY = 10;

async function queueMail(
  ctx: ServiceContext,
  userId: string,
  passId: string,
  reason: 'resend' | 'lost_phone',
  operationId: string,
) {
  await ctx.env.JOBS.send({ kind: 'pass.holder_mail', passId, userId, reason, operationId });
}

/** Send my own pass to the email it was issued to; the delivery caps apply. */
export async function resendMyPass(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  passId: string,
) {
  const { row, to } = await ownedActive(ctx, userId, passId);
  const who = { userId, sessionId };
  await assertNoActiveHolderOperation(ctx, who, 'holder.resend', passId);
  if (!(await checkRateLimit(ctx.env, 'RL_REFRESH', `holder-resend:${passId}`)))
    throw new RateLimitedError();
  await assertRecipientBudget(ctx, row.mode, to);
  const op = await startHolderOperation(ctx, who, 'holder.resend', passId);
  await op.progress.step('check').done();
  await queueMail(ctx, userId, passId, 'resend', op.id);
  return { ok: true as const, operationId: op.id };
}

/**
 * Lost phone: new code and link, old copies refused, the pass sent again. Only the signed-in owner,
 * only to the pass's own email: the body names nothing, so a pass cannot move to another person.
 */
export async function lostMyPhone(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  passId: string,
) {
  const { row } = await ownedActive(ctx, userId, passId);
  const who = { userId, sessionId };
  if (
    !(await checkRateLimit(ctx.env, 'RL_REFRESH', `holder-lost:${userId}`)) ||
    !(await checkRateLimit(ctx.env, 'RL_REFRESH', `holder-lost:${passId}`))
  )
    throw new RateLimitedError();
  const now = ctx.clock.now();
  if (
    (await bump(ctx.env.DB, `holder-lost:pass:${passId}`, now - (now % HOUR))) >
      LOST_PER_PASS_HOUR ||
    (await bump(ctx.env.DB, `holder-lost:user:${userId}`, now - (now % DAY))) > LOST_PER_USER_DAY
  )
    throw new RateLimitedError();
  const result = await rotateOwnPassCredentials(
    ctx,
    passId,
    userId,
    sessionId,
    sourceOf(userId, row),
  ).catch((error: unknown) => {
    if (error instanceof CredentialTransferReissueRequired)
      throw new ConflictError(
        `This pass's code can't change. Ask ${row.org_name || 'the organization'}.`,
        'PASS_CREDENTIAL_FIXED',
      );
    throw error;
  });
  const op = await startHolderOperation(ctx, who, 'holder.lost_phone', passId);
  try {
    await op.progress.step('rotate').done();
    // The lost phone's other sessions end with the old code: a finder cannot open My passes. This session stays,
    // and the operation is pinned to it, so the holder watches the rest.
    await revokeAllForUser(ctx, userId, sessionId);
    await recordAudit(ctx, {
      actorType: 'user',
      actorId: userId,
      action: 'user.sessions_revoke',
      targetType: 'user',
      targetId: userId,
      detail: { reason: 'lost_phone' },
    });
    await op.progress.step('signout').done();
    if (result.state === 'pending')
      await op.progress.waiting('wallets', { reason: 'Waiting for your wallets' });
    else await op.progress.step('wallets').skip();
    // A pending transfer finishes later; the job waits for it and then mails the new pass.
    await queueMail(ctx, userId, passId, 'lost_phone', op.id);
  } catch (error) {
    await op.progress.fail(error);
    throw error;
  }
  return { ...result, operationId: op.id };
}
