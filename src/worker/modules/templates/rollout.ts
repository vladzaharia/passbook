import type { TemplateRollout, TemplateRolloutQuery } from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { activeRelease } from './releases.ts';
import { scopedTemplate } from './releases-domain.ts';
import {
  countActivePasses,
  countPassesNotOnVersion,
  countRecordedFailures,
  listLeftBehind,
  rebuildsSince,
} from './repo-release-impact.ts';

const FAILED_SHOWN = 50;
const LEFT_BEHIND = 'Left on its old version. Open the pass to see why.';
/** Tell holders is offered for a day after a release. */
export const TELL_WINDOW_MS = 24 * 3_600_000;

/**
 * Read-only: where the approved release stands for the org's passes in one mode. A pass is
 * left behind when the rebuild recorded why, or when every rebuild since the release has
 * finished and it is still not on it.
 */
export async function templateRollout(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  query: TemplateRolloutQuery,
): Promise<TemplateRollout> {
  const scope = { orgId: query.orgId, mode: query.mode, provider: 'apple' } as const;
  const template = await scopedTemplate(ctx, auth, templateId, scope);
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
      tell: null,
    };
  const input = { ...base, version: release.version, limit: total + 1 };
  const remaining = await countPassesNotOnVersion(ctx.env.DB, input);
  const runs = await rebuildsSince(ctx.env.DB, {
    templateId,
    orgId: query.orgId,
    since: release.createdAt,
  });
  const running = runs.open > 0;
  const settled = runs.n > 0 && !running && remaining > 0;
  const left = { ...input, releaseId: release.id };
  const failedCount = settled ? remaining : await countRecordedFailures(ctx.env.DB, left);
  const stuck =
    failedCount > 0
      ? await listLeftBehind(ctx.env.DB, { ...left, settled, limit: FAILED_SHOWN })
      : [];
  const until = release.createdAt + TELL_WINDOW_MS;
  const updating = remaining - failedCount;
  const moved = total - remaining;
  const open = ctx.clock.now() < until;
  const tell: TemplateRollout['tell'] =
    !open || total === 0
      ? null
      : updating > 0
        ? { path: 'change', text: null, until }
        : moved > 0
          ? { path: 'message', text: `${template.name} has a new design.`.slice(0, 120), until }
          : null;
  return {
    releaseVersion: release.version,
    total,
    onRelease: Math.max(0, moved),
    remaining,
    failed: stuck.map((p) => ({ passId: p.id, title: p.title, reason: p.message ?? LEFT_BEHIND })),
    failedCount,
    startedAt: release.createdAt,
    runId: runs.latestId,
    running,
    tell,
  };
}
