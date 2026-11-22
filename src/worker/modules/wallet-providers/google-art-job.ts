import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { storeReleaseArt } from './projection-service-support.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';

/** `wallet.google_art`: cuts and stores a release's art again (idempotent), as publication did. */
export async function handleGoogleArt(
  job: JobOf<'wallet.google_art'>,
  ctx: ServiceContext,
): Promise<void> {
  const candidate = await getProjectionCandidate(ctx.env.DB, job.candidateId);
  if (candidate?.provider !== 'google') return;
  await storeReleaseArt(ctx, candidate, 'exact');
}
