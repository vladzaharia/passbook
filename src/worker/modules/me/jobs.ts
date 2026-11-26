import type { JobOf } from '../../jobs/types.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { lastRotationAt, noticeQueuedSince } from '../channels/repo-replace.ts';
import { dispatchSafely, enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { hasPendingIssuanceTransfer } from '../delivery/repo-issuance-recovery.ts';
import { progressOf } from '../operations/progress.ts';
import { getPass } from '../passes/repo-read-pass.ts';

const MAIL_ACTION = {
  resend: 'holder.resend',
  lost_phone: 'holder.lost_phone_mail',
  codes_replaced: 'holder.codes_replaced_mail',
  channel_off: 'holder.channel_off_mail',
} as const;

/**
 * Mails a holder their own pass, to the email it was issued to. The request already checked
 * ownership; it is checked again here, and the delivery caps apply as for any pass email.
 */
export async function handleHolderMail(
  job: JobOf<'pass.holder_mail'>,
  ctx: ServiceContext,
): Promise<void> {
  // The holder's operation, when there is one: it shows each step and where this stopped.
  const progress = progressOf(ctx, job.operationId, 1);
  // A lost-phone transfer still finishing: fail so the queue retries after its backoff.
  if (await hasPendingIssuanceTransfer(ctx.env.DB, job.passId)) {
    if (job.reason === 'lost_phone')
      await progress.waiting('wallets', { reason: 'Waiting for your wallets' });
    throw new ConflictError('The pass is changing. Retrying.', 'HOLDER_TRANSFER_PENDING');
  }
  const pass = await getPass(ctx.env.DB, job.passId);
  if (
    !pass ||
    (job.userId !== null && pass.ownerUserId !== job.userId) ||
    !pass.holderEmail ||
    pass.status === 'voided' ||
    pass.removedAt !== null
  ) {
    await progress.fail(new AppError('PASS_NOT_FOUND', 404, 'Pass not found.'));
    return;
  }
  if (job.reason === 'lost_phone') await progress.step('wallets').done();
  const mail = progress.step('mail');
  // A notice is queued once per new code: a retry after a crash finds the audit row of the first.
  if (job.reason === 'codes_replaced') {
    const since = await lastRotationAt(ctx.env.DB, pass.orgId, pass.id);
    if (since !== null && (await noticeQueuedSince(ctx.env.DB, pass.orgId, pass.id, since))) return;
  }
  try {
    await enqueuePassEmail(ctx, {
      passId: pass.id,
      to: pass.holderEmail,
      attach: false,
      expected: pass,
      ...(job.reason === 'codes_replaced' || job.reason === 'channel_off'
        ? { notice: { reason: job.reason, ...(job.channels ? { channels: job.channels } : {}) } }
        : {}),
      auditEntry: {
        orgId: pass.orgId,
        actorType: job.userId === null ? 'system' : 'user',
        actorId: job.userId,
        action: MAIL_ACTION[job.reason],
        targetType: 'pass',
        targetId: pass.id,
      },
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('holder.mail_skipped', { passId: pass.id, code: error.code });
    await progress.fail(error);
    return;
  }
  ctx.waitUntil(dispatchSafely(ctx, { passId: pass.id }));
  await mail.done();
  await progress.succeed();
}
