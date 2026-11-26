import type { TemplateRelease } from '../../../shared/contracts/template-releases.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { publishableSchema } from './projection-contract.ts';
import { SYSTEM_AUTHORED_PROVIDERS } from './projection-system-authority.ts';
import { walletProviderDisabledReason } from './provider-policy.ts';

const PROVIDERS = ['google', 'samsung'] as const;

/**
 * An Apple release or rollback moved the source head, so each provider projection built on the old
 * head needs a new candidate. Queued, not inline: the job writes under system authority. A failed
 * enqueue must not fail the release; it is logged and the next release queues again.
 */
export async function queueSystemProjections(
  ctx: ServiceContext,
  release: TemplateRelease,
): Promise<void> {
  if (release.provider !== 'apple' || !release.orgId) return;
  const { orgId, mode, templateId, version } = release;
  try {
    // Only orgs with a provider account have anything to project; others queue nothing.
    const open = PROVIDERS.filter(
      (provider) => SYSTEM_AUTHORED_PROVIDERS.includes(provider) && publishableSchema(provider, 2),
    );
    const ready: (typeof PROVIDERS)[number][] = [];
    for (const provider of open) {
      const readiness = await getWalletProviderReadiness(ctx, { orgId, mode, provider });
      // A pair that is not released, or an enrolment that cannot issue, would strand the candidate: the backfill
      // covers it when the mode is released or the enrolment is turned On.
      if (
        readiness.accountId &&
        readiness.state !== 'revoked' &&
        readiness.state !== 'absent' &&
        (await walletProviderDisabledReason(ctx.env.DB, provider, orgId, mode)) === null
      )
        ready.push(provider);
    }
    if (ready.length === 0) return;
    await ctx.env.JOBS.sendBatch(
      ready.map((provider) => ({
        body: {
          kind: 'wallet.projection_system' as const,
          orgId,
          mode,
          templateId,
          sourceReleaseId: release.id,
          version,
          provider,
        },
      })),
    );
  } catch (error) {
    ctx.log.error('wallet.projection_system_enqueue_failed', {
      orgId,
      code: 'WALLET_PROJECTION_SYSTEM_ENQUEUE',
      error,
    });
  }
}
