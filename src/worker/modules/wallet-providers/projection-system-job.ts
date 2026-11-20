import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { runSystemProjection } from './projection-system.ts';

/** `wallet.projection_system`: the provider candidate of a new Apple release, authored by the platform. */
export function handleProjectionSystem(
  job: JobOf<'wallet.projection_system'>,
  ctx: ServiceContext,
): Promise<void> {
  return runSystemProjection(ctx, job);
}
