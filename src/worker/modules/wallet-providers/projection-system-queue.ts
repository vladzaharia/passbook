import type { TemplateRelease } from '../../../shared/contracts/template-releases.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { publishableSchema } from './projection-contract.ts';

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
    await ctx.env.JOBS.sendBatch(
      PROVIDERS.filter((provider) => publishableSchema(provider, 2)).map((provider) => ({
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
