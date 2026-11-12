import { rowIs } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOutbox } from '../delivery/repo-outbox.ts';
import { beginProviderAttempt } from '../delivery/repo-provider-attempt.ts';
import { BundleEmailIntentSchema, type BundleEmailSnapshot } from './email-binding.ts';
import { bundleChecks } from './repo-delivery-fence.ts';

/** The provider-boundary marker for a queued bundle email, as `deliverBundleEmail` writes it. */
export async function beginBundleAttemptFor(
  ctx: ServiceContext,
  outboxId: string,
  lease: string,
  snapshot: BundleEmailSnapshot,
  now: number,
): Promise<boolean> {
  const row = await getOutbox(ctx.env.DB, outboxId);
  const intent = BundleEmailIntentSchema.parse(row?.payload.intent);
  const first = snapshot.passes[0];
  if (!row || !first) return false;
  return (
    (await beginProviderAttempt(ctx, {
      id: outboxId,
      lease,
      orgId: snapshot.bundle.org_id,
      mode: snapshot.bundle.mode,
      passId: first.id,
      output: {
        actor: intent.actor ?? { kind: 'system' },
        checks: [rowIs('passes', first.id, { deleted_at: null }), ...bundleChecks(snapshot)],
      },
      now,
    })) === 'started'
  );
}
