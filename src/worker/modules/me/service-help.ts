import { read } from '../../platform/counters.ts';
import { AppError, ConflictError, NotFoundError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { EMAIL_RECIPIENT_HOURLY_CAP } from '../delivery/issuance-intent.ts';
import { recipientKey } from '../delivery/recipient-key.ts';
import { rotateOwnPassCredentials } from '../holders/service-rotate.ts';
import * as repo from './repo.ts';
import { sourceOf } from './service.ts';

async function ownedActive(ctx: ServiceContext, userId: string, passId: string) {
  const row = await repo.getMyPass(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  if (row.status === 'voided') throw new ConflictError('This pass is voided.', 'PASS_VOIDED');
  if (!row.holder_email) throw new ConflictError('The pass has no email.', 'NO_RECIPIENT');
  return { row, to: row.holder_email };
}

const HOUR = 3_600_000;

/** The queued mail would be refused at the recipient cap: say so now, not silently later. */
async function assertRecipientBudget(ctx: ServiceContext, mode: string, to: string) {
  const now = ctx.clock.now();
  const used = await read(
    ctx.env.DB,
    `pass-email:${mode}:to:${await recipientKey(ctx.env, to)}`,
    now - (now % HOUR),
  );
  if (used >= EMAIL_RECIPIENT_HOURLY_CAP)
    throw new AppError(
      'EMAIL_RATE_LIMITED',
      429,
      'Too many emails to this address. Try again in an hour.',
    );
}

async function queueMail(
  ctx: ServiceContext,
  userId: string,
  passId: string,
  reason: 'resend' | 'lost_phone',
) {
  await ctx.env.JOBS.send({ kind: 'pass.holder_mail', passId, userId, reason });
}

/** Send my own pass to the email it was issued to; the delivery caps apply. */
export async function resendMyPass(ctx: ServiceContext, userId: string, passId: string) {
  const { row, to } = await ownedActive(ctx, userId, passId);
  if (!(await checkRateLimit(ctx.env, 'RL_REFRESH', `holder-resend:${passId}`)))
    throw new RateLimitedError();
  await assertRecipientBudget(ctx, row.mode, to);
  await queueMail(ctx, userId, passId, 'resend');
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
  if (!(await checkRateLimit(ctx.env, 'RL_REFRESH', `holder-lost:${userId}`)))
    throw new RateLimitedError();
  const result = await rotateOwnPassCredentials(
    ctx,
    passId,
    userId,
    sessionId,
    sourceOf(userId, row),
  );
  if (result.state === 'completed') await queueMail(ctx, userId, passId, 'lost_phone');
  return result;
}
