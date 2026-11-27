import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { runUncertainRecheck } from './health.ts';

/** `wallet.uncertain_recheck`: the operator's recheck of one wallet's uncertain updates. */
export async function handleUncertainRecheck(
  job: JobOf<'wallet.uncertain_recheck'>,
  ctx: ServiceContext,
): Promise<void> {
  await runUncertainRecheck(ctx, job);
}
