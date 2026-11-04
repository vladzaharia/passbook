import type { ServiceContext } from '../../platform/service-context.ts';
import { finishOutbox, type OutboxRow, setProviderId } from './repo.ts';

/**
 * The provider has the message. A bookkeeping failure must not cause a second send: the provider id
 * is kept so a lease-expiry re-run only finishes the row.
 */
export async function finishSent(
  ctx: ServiceContext,
  row: OutboxRow,
  lease: string,
  messageId: string,
): Promise<void> {
  try {
    await finishOutbox(ctx.env.DB, row.id, lease, 'sent', ctx.clock.now(), null, messageId);
  } catch (error) {
    ctx.log.error('email.finish_failed', { outboxId: row.id, code: 'EMAIL_FINISH', error });
    await setProviderId(ctx.env.DB, row.id, lease, messageId).catch((inner: unknown) =>
      ctx.log.error('email.finish_failed', {
        outboxId: row.id,
        code: 'EMAIL_PROVIDER_ID',
        error: inner,
      }),
    );
  }
}
