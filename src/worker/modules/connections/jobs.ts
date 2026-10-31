import type { JobOf } from '../../jobs/types.ts';
import { NotImplementedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export async function handlePassRefresh(
  _job: JobOf<'pass.refresh'>,
  _ctx: ServiceContext,
): Promise<void> {
  throw new NotImplementedError('pass.refresh is not implemented yet.');
}

export async function handleConnectionSync(
  _job: JobOf<'connection.sync'>,
  _ctx: ServiceContext,
): Promise<void> {
  throw new NotImplementedError('connection.sync is not implemented yet.');
}

export async function handleConnectionWebhook(
  _job: JobOf<'connection.webhook'>,
  _ctx: ServiceContext,
): Promise<void> {
  throw new NotImplementedError('connection.webhook is not implemented yet.');
}

export async function reconcileConnections(_ctx: ServiceContext): Promise<void> {}
