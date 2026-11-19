import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { runEnrolmentHold } from './enrolment-service.ts';

/** `wallet.enrolment_hold`: the platform's hold on a suspended org, which no request grant reaches. */
export function handleEnrolmentHold(
  job: JobOf<'wallet.enrolment_hold'>,
  ctx: ServiceContext,
): Promise<void> {
  return runEnrolmentHold(ctx, job);
}
