import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely, enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { getPass } from '../passes/repo-read-pass.ts';

/**
 * Mails a holder their own pass, to the email it was issued to. The request already checked
 * ownership; it is checked again here, and the delivery caps apply as for any pass email.
 */
export async function handleHolderMail(
  job: JobOf<'pass.holder_mail'>,
  ctx: ServiceContext,
): Promise<void> {
  const pass = await getPass(ctx.env.DB, job.passId);
  if (!pass || pass.ownerUserId !== job.userId || !pass.holderEmail || pass.status === 'voided')
    return;
  try {
    await enqueuePassEmail(ctx, {
      passId: pass.id,
      to: pass.holderEmail,
      attach: false,
      expected: pass,
      auditEntry: {
        orgId: pass.orgId,
        actorType: 'user',
        actorId: job.userId,
        action: job.reason === 'resend' ? 'holder.resend' : 'holder.lost_phone_mail',
        targetType: 'pass',
        targetId: pass.id,
      },
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('holder.mail_skipped', { passId: pass.id, code: error.code });
    return;
  }
  ctx.waitUntil(dispatchSafely(ctx, { passId: pass.id }));
}
