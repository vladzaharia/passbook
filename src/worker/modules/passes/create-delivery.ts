import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scheduleIssuanceDelivery } from '../delivery/issuance-intent.ts';

/**
 * Queues the issuance mail after the pass committed. The delivery intent is durable, so a storage failure
 * here is logged and left to the delivery sweep; a stale or cancelled intent is a conflict for the caller.
 */
export async function scheduleRequiredIssuanceDelivery(
  ctx: ServiceContext,
  passId: string,
): Promise<void> {
  let result: Awaited<ReturnType<typeof scheduleIssuanceDelivery>>;
  try {
    result = await scheduleIssuanceDelivery(ctx, passId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    ctx.log.error('pass.issuance_delivery_deferred', {
      code: 'ISSUANCE_DELIVERY_ENQUEUE',
      passId,
      error,
    });
    return;
  }
  if (result === 'cancelled' || result === 'none')
    throw new ConflictError(
      'The pass or delivery authorization changed. Review and retry.',
      'DELIVERY_STALE',
    );
}
