import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ChangeObserver } from './sync-apply.ts';
import { finishRetainedWebhookItem, startRetainedWebhookItem } from './webhook-retention-items.ts';

/** Bind each applied change to its retained item and captured credential context. */
export function webhookItemObserver(
  sctx: ServiceContext,
  job: JobOf<'connection.webhook'>,
  revision: number,
  credentialKeysetCommitment: string,
): ChangeObserver {
  return {
    begin: async (index, candidate) => {
      const claim = await startRetainedWebhookItem(sctx, job, revision, index, candidate);
      if (
        claim &&
        (claim.revision !== revision ||
          claim.credentialKeysetCommitment !== credentialKeysetCommitment ||
          (claim.retainedClaim &&
            (claim.retainedClaim.revision !== revision ||
              claim.retainedClaim.credentialKeysetCommitment !== credentialKeysetCommitment)))
      ) {
        await finishRetainedWebhookItem(sctx, job, revision, index, claim.token, 'uncertain');
        return null;
      }
      return claim;
    },
    finish: (index, token, outcome, code) =>
      finishRetainedWebhookItem(sctx, job, revision, index, token, outcome, code),
  };
}
