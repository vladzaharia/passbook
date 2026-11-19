import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { runCredentialCheck } from './account-check.ts';

/** `wallet.credential_check`: the one writer of a credential check. */
export function handleCredentialCheck(
  job: JobOf<'wallet.credential_check'>,
  ctx: ServiceContext,
): Promise<void> {
  return runCredentialCheck(ctx, job);
}
