import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getVersion, latestVersionName } from './repo.ts';
import { effectiveBase, type ForkLineage, getFork } from './repo-forks.ts';

/**
 * A fork's new version keeps the upstream base of the version it was edited from: `parentVersion`, or
 * the tip. Saving from an older version than the tip still succeeds and says so (`behindTip`).
 */
export async function editLineage(
  ctx: ServiceContext,
  templateId: string,
  parentVersion: string | undefined,
): Promise<{ lineage?: ForkLineage; behindTip: boolean }> {
  const fork = await getFork(ctx.env.DB, templateId);
  if (!fork) return { behindTip: false };
  const tip = await latestVersionName(ctx.env.DB, templateId);
  if (parentVersion && !(await getVersion(ctx.env.DB, templateId, parentVersion)))
    throw new ConflictError('The template changed. Reload and retry.', 'TEMPLATE_VERSION_CONFLICT');
  const parent = parentVersion ?? tip;
  const base = parent ? await effectiveBase(ctx.env.DB, templateId, parent) : null;
  return {
    behindTip: parentVersion !== undefined && tip !== undefined && parentVersion !== tip,
    ...(base
      ? {
          lineage: {
            upstreamId: fork.upstreamId,
            create: false,
            bases: [
              {
                upstreamVersion: base.upstreamVersion,
                contentHash: base.contentHash,
                via: 'edit' as const,
                parentVersion: parent ?? null,
              },
            ],
          },
        }
      : {}),
  };
}
