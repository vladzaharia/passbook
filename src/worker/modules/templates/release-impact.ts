import type {
  TemplateReleaseImpact,
  TemplateReleaseImpactQuery,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { versionDiff } from './release-impact-diff.ts';
import { activeRelease } from './releases.ts';
import { repositoryScope, scopedTemplate } from './releases-domain.ts';
import { getVersion } from './repo.ts';
import { countPassesNotOnVersion } from './repo-release-impact.ts';
import { getLatestRelease } from './repo-releases.ts';

const COUNT_CAP = 10_000;

/** Passes of the org on the template, in the release's mode, that are not yet on `version`. */
async function affectedPasses(
  ctx: ServiceContext,
  query: TemplateReleaseImpactQuery,
  templateId: string,
  version: string,
): Promise<TemplateReleaseImpact['passes']> {
  const n = await countPassesNotOnVersion(ctx.env.DB, {
    templateId,
    orgId: query.orgId,
    mode: query.mode,
    version,
    limit: COUNT_CAP + 1,
  });
  return { count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP };
}

/** What a publish or rollback to `query.version` changes, and how many passes it reaches. */
export async function releaseImpact(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  query: TemplateReleaseImpactQuery,
): Promise<TemplateReleaseImpact> {
  const template = await scopedTemplate(ctx, auth, templateId, query);
  const target = await getVersion(ctx.env.DB, templateId, query.version);
  if (!target) throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
  // An archived template serves no head; a rollback that restores it replaces its last release.
  const head =
    (await activeRelease(ctx, templateId, query.orgId, query.mode, query.provider)) ??
    (template.status === 'archived'
      ? await getLatestRelease(ctx.env.DB, repositoryScope(templateId, query))
      : null);
  const current = head ? await getVersion(ctx.env.DB, templateId, head.version) : null;
  return {
    fromVersion: head?.version ?? null,
    toVersion: target.version,
    passes: await affectedPasses(ctx, query, templateId, target.version),
    ...versionDiff(current, target),
  };
}
