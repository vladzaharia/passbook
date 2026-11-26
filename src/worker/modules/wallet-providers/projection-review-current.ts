import type { TemplateCandidateCurrent } from '../../../shared/contracts/template-releases.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getVersion } from '../templates/repo.ts';
import { getLatestRelease } from '../templates/repo-releases.ts';
import { computeProjectionPins } from './projection-pins.ts';
import type { ProjectionScope } from './repo-projection-store.ts';

/**
 * The report a reviewer would approve now: the wallet's compile of the version the Apple release
 * serves, under today's pipeline. A report that cannot be built is logged and left out, so the
 * list still loads and the row reads "Checking" instead of a wrong state.
 */
export async function currentReview(
  ctx: ServiceContext,
  scope: ProjectionScope,
): Promise<TemplateCandidateCurrent | undefined> {
  const apple = await getLatestRelease(ctx.env.DB, { ...scope, provider: 'apple' });
  if (!apple) return undefined;
  const version = await getVersion(ctx.env.DB, scope.templateId, apple.version);
  if (!version) return undefined;
  try {
    const { report } = await computeProjectionPins(
      ctx,
      scope.provider,
      version,
      'dry',
      scope.orgId,
    );
    return { version: apple.version, sourceReleaseId: apple.id, report };
  } catch (error) {
    ctx.log.error('wallet.review_report_failed', { code: 'WALLET_REVIEW_REPORT', error });
    return undefined;
  }
}
