import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { runManagedIssuer } from './issuer-provision.ts';
import { runKeyRotation } from './sa-key-rotation.ts';

/** `wallet.google_issuer`: one step run of a managed issuer (safe to run twice). */
export function handleGoogleIssuer(
  job: JobOf<'wallet.google_issuer'>,
  ctx: ServiceContext,
): Promise<void> {
  return runManagedIssuer(ctx, job.runId);
}

/** `wallet.google_key_rotate`: one pass of a service-account key rotation. */
export function handleGoogleKeyRotate(
  job: JobOf<'wallet.google_key_rotate'>,
  ctx: ServiceContext,
): Promise<void> {
  return runKeyRotation(ctx, job.runId);
}
