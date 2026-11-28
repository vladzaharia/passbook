import type { Mode } from '../../../shared/contracts/common.ts';
import { isStrongAmr } from '../../../shared/sign-in.ts';
import { bump } from '../../platform/counters.ts';
import {
  AppError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { withinCaps, withinDailyCap, withinIpCap } from '../auth/magic-caps.ts';
import { issueMagicLink } from '../auth/magic-service.ts';
import { revokeAllForUser } from '../auth/sessions.ts';
import { recipientEmailBudget } from '../delivery/repo-email-budget.ts';
import { rotateOwnPassCredentials } from '../holders/service-rotate.ts';
import { CredentialTransferReissueRequired } from '../passes/credential-transfer.ts';
import { FIRST_CHECK_S, sendWaitCheck, waitOnWallets } from './operations.ts';
import { assertNoActiveHolderOperation, startHolderOperation } from './operations-start.ts';
import * as repo from './repo.ts';
import { sourceOf } from './service-actions.ts';

async function ownedActive(ctx: ServiceContext, userId: string, passId: string) {
  const row = await repo.getMyPass(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (row.status === 'voided') throw new ConflictError('This pass is voided.', 'PASS_VOIDED');
  if (!row.holder_email) throw new ValidationError('The pass has no email.', [], 'NO_RECIPIENT');
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
const CONFIRM_PER_PASS_HOUR = 3;

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

const FRESH_MS = 10 * 60_000;

/**
 * Lost phone replaces the code and signs every other device out, so the one that asks must have just proved the
 * inbox: a session that came from an email link, or a Polaris ID sign-in, in the last 10 minutes. A finder holding a stolen session does not
 * have it; the owner confirms by a link and the action runs from that new session, which is the one kept.
 */
async function assertFreshEmailSession(ctx: ServiceContext, sessionId: string) {
  const born = await repo.sessionBirth(ctx.env.DB, sessionId);
  const since = ctx.clock.now() - FRESH_MS;
  // An email link just opened, or a strong (Polaris ID) sign-in just proven: either shows the person is here now.
  const fresh =
    born !== null &&
    ((born.amr === 'magic_link' && born.created_at >= since) ||
      (isStrongAmr(born.amr) && (born.auth_time ?? born.created_at) >= since));
  if (!fresh)
    throw new AppError(
      'EMAIL_CONFIRMATION_REQUIRED',
      409,
      'Confirm by email first. Open the link we send, then try again.',
    );
}

/** Mails the owner a sign-in link that lands back on this pass, to run lost phone from a fresh session. */
export async function sendLostPhoneConfirmation(
  ctx: ServiceContext,
  userId: string,
  passId: string,
  bindingHash: string,
  ipPrefix: string | null,
) {
  const { to } = await ownedActive(ctx, userId, passId);
  // The same caps as a sign-in request (address, day, address per hour, network), and a count per pass.
  const now = ctx.clock.now();
  if (
    !(await withinIpCap(ctx, ipPrefix)) ||
    !(await withinCaps(ctx, to)) ||
    !(await withinDailyCap(ctx)) ||
    (await bump(ctx.env.DB, `holder-lost-confirm:pass:${passId}`, now - (now % HOUR))) >
      CONFIRM_PER_PASS_HOUR
  )
    throw new RateLimitedError();
  await issueMagicLink(ctx, {
    email: to,
    purpose: 'sign_in',
    userId,
    bindingHash,
    next: `/passes/${passId}?lostPhone=${passId}`,
    prefer: 'link',
  });
  return { ok: true as const };
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
  await assertFreshEmailSession(ctx, sessionId);
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
  // The lost phone's other sessions end with the old code, before any bookkeeping can fail: a finder cannot open
  // My passes. This session stays, and the operation is pinned to it, so the holder watches the rest.
  await revokeAllForUser(ctx, userId, sessionId);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'user.sessions_revoke',
    targetType: 'user',
    targetId: userId,
    detail: { reason: 'lost_phone' },
  });
  const op = await startHolderOperation(ctx, who, 'holder.lost_phone', passId);
  try {
    await op.progress.step('rotate').done();
    await op.progress.step('signout').done();
    if (result.state === 'pending') {
      // The runner waits for the transfer and then queues the mail. The look is queued before the wait is written.
      await sendWaitCheck(ctx, op.id, 1, FIRST_CHECK_S);
      await waitOnWallets(op.progress, ctx.clock.now());
    } else {
      await op.progress.step('wallets').skip();
      await queueMail(ctx, userId, passId, 'lost_phone', op.id);
    }
  } catch (error) {
    await op.progress.fail(error);
    throw error;
  }
  return { ...result, operationId: op.id };
}
