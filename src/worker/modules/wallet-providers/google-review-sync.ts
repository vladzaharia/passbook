import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { refreshGoogleClassReview } from './google-class-review.ts';
import { getWalletInstance, getWalletOperation } from './instance.ts';
import { recordGoogleClassReviewFailure } from './repo-google-class-write.ts';
import { listDueGoogleClassReviews } from './repo-google-review.ts';
import { originalScope } from './sync-operation-context.ts';

/** Classes read per minute; the rest wait for the next tick. */
export const REVIEW_TICK_BATCH = 25;

/**
 * Minute hook: Google decides a class's review in its own time, so classes nobody touches are read here
 * until they settle (approved or rejected). Per class: one claimed read per backoff window, and a failed
 * read waits 1, 5 and 30 minutes, then 6 hours. A provider or mode the platform has not released, or an org
 * whose enrolment is not on, is never selected, so a dark provider is never called.
 */
export async function syncGoogleClassReviews(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  for (const due of await listDueGoogleClassReviews(ctx.env.DB, now, REVIEW_TICK_BATCH)) {
    const instance = await getWalletInstance(ctx.env.DB, {
      orgId: due.orgId,
      mode: due.mode,
      provider: 'google',
      passId: due.passId,
    });
    const op =
      instance && 'accountId' in instance
        ? await getWalletOperation(ctx.env.DB, {
            orgId: due.orgId,
            mode: due.mode,
            provider: 'google',
            instanceId: instance.id,
            version: instance.desiredVersion,
          })
        : null;
    const binding = op ? await originalScope(ctx, op) : null;
    const releaseId = instance?.identityProjectionReleaseId;
    if (!releaseId || !binding) {
      await recordGoogleClassReviewFailure(ctx.env.DB, due.classIdHash, now);
      continue;
    }
    const outcome = await refreshGoogleClassReview(ctx, binding.scope, {
      releaseId,
      type: (due.classType as GoogleType | null) ?? 'generic',
      ...(due.classKey ? { classKey: due.classKey } : {}),
    });
    if (outcome === 'failed')
      await recordGoogleClassReviewFailure(ctx.env.DB, due.classIdHash, now);
  }
}
