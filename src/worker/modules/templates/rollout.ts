import type { TemplateRollout, TemplateRolloutQuery } from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { activeRelease } from './releases.ts';
import { scopedTemplate } from './releases-domain.ts';
import {
  countActivePasses,
  countPassesNotOnVersion,
  listPassesNotOnVersion,
  rebuildsSince,
} from './repo-release-impact.ts';

const FAILED_SHOWN = 50;
const LEFT_BEHIND = 'Left on its old version. Open the pass to see why.';

/**
 * Read-only: where the approved release stands for the org's passes in one mode. A pass counts as
 * failed once every rebuild since the release has finished and it is still not on it.
 */
export async function templateRollout(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  query: TemplateRolloutQuery,
): Promise<TemplateRollout> {
  const scope = { orgId: query.orgId, mode: query.mode, provider: 'apple' } as const;
  await scopedTemplate(ctx, auth, templateId, scope);
  const release = await activeRelease(ctx, templateId, query.orgId, query.mode, 'apple');
  const base = { templateId, orgId: query.orgId, mode: query.mode };
  const total = await countActivePasses(ctx.env.DB, base);
  if (!release)
    return {
      releaseVersion: null,
      total,
      onRelease: total,
      remaining: 0,
      failed: [],
      failedCount: 0,
      startedAt: null,
      runId: null,
      running: false,
    };
  const input = { ...base, version: release.version };
  const remaining = await countPassesNotOnVersion(ctx.env.DB, { ...input, limit: total + 1 });
  const runs = await rebuildsSince(ctx.env.DB, {
    templateId,
    orgId: query.orgId,
    since: release.createdAt,
  });
  const running = runs.open > 0;
  const settled = runs.n > 0 && !running && remaining > 0;
  const stuck = settled
    ? await listPassesNotOnVersion(ctx.env.DB, { ...input, limit: FAILED_SHOWN })
    : [];
  return {
    releaseVersion: release.version,
    total,
    onRelease: Math.max(0, total - remaining),
    remaining,
    failed: stuck.map((p) => ({ passId: p.id, title: p.title, reason: LEFT_BEHIND })),
    failedCount: settled ? remaining : 0,
    startedAt: release.createdAt,
    runId: runs.latestId,
    running,
  };
}
