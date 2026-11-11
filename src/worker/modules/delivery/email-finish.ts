import type { ServiceContext } from '../../platform/service-context.ts';
import { completeProviderAttempt, rememberProviderAcceptance } from './repo-binding.ts';
import type { OutboxRow } from './repo-outbox-map.ts';

/** Record provider acceptance before downstream event/analytics writes. */
export async function finishSent(
  ctx: ServiceContext,
  row: OutboxRow,
  lease: string,
  messageId: string,
): Promise<void> {
  try {
    const stored = await completeProviderAttempt(
      ctx.env.DB,
      row.id,
      lease,
      messageId,
      ctx.clock.now(),
    );
    if (!stored)
      ctx.log.error('email.finish_failed', { outboxId: row.id, code: 'EMAIL_FINISH_LEASE' });
  } catch (error) {
    ctx.log.error('email.finish_failed', { outboxId: row.id, code: 'EMAIL_FINISH', error });
    await rememberProviderAcceptance(ctx.env.DB, row.id, lease, messageId).catch((inner: unknown) =>
      ctx.log.error('email.finish_failed', {
        outboxId: row.id,
        code: 'EMAIL_PROVIDER_ID',
        error: inner,
      }),
    );
  }
}
