import { NotImplementedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** Workstream d owns this module. Keep the signatures. */

/** Push to every registered device even if the pass didn't change (force refresh catch-up). */
export async function enqueuePush(
  _ctx: ServiceContext,
  _passId: string,
  _reason: 'publish' | 'refresh',
): Promise<void> {
  throw new NotImplementedError('delivery.enqueuePush');
}

export async function enqueuePassEmail(
  _ctx: ServiceContext,
  _input: { passId: string; to: string; attach: boolean },
): Promise<{ outboxId: string }> {
  throw new NotImplementedError('delivery.enqueuePassEmail');
}
