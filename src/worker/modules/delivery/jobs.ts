import type { JobOf } from '../../jobs/types.ts';
import { NotImplementedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export async function handlePushDeliver(
  _job: JobOf<'push.deliver'>,
  _ctx: ServiceContext,
): Promise<void> {
  throw new NotImplementedError('push.deliver is not implemented yet.');
}

export async function handleEmailSend(
  _job: JobOf<'email.send'>,
  _ctx: ServiceContext,
): Promise<void> {
  throw new NotImplementedError('email.send is not implemented yet.');
}

export async function sweepDelivery(_ctx: ServiceContext): Promise<void> {}

export async function dailyDelivery(_ctx: ServiceContext): Promise<void> {}

/** Finalizes a job that exhausted its retries: mark the outbox row failed and write an audit event. */
export async function handleDeadLetter(
  _job: import('../../jobs/types.ts').Job,
  _ctx: ServiceContext,
): Promise<void> {}
