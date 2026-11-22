import type {
  ReleaseDiffGroup,
  TemplateRollout,
  TemplateRolloutQuery,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { groupedDiff } from './release-flow-diff.ts';
import { activeRelease } from './releases.ts';
import { scopedTemplate } from './releases-domain.ts';
import { getVersion } from './repo.ts';
import { countPassesNotOnVersion } from './repo-release-impact.ts';
import { getRelease } from './repo-releases.ts';
import {
  countActivePasses,
  countRecordedFailures,
  listLeftBehind,
  rebuildsOf,
  tellSent,
  updatingByVersion,
} from './repo-rollout.ts';

const FAILED_SHOWN = 50;
const LEFT_BEHIND = 'Not moved by the last rebuild.';
const NO_REBUILD = 'No rebuild ran for this release.';
/** Tell holders is offered for a day after a release. */
export const TELL_WINDOW_MS = 24 * 3_600_000;
/** The cron queues a release after a quiet minute; no rebuild by then plus this grace is a stall. */
const STALL_MS = 11 * 60_000;
const TEXT_MAX = 120;

/** The pass list needs passes:read as well as templates:read: a title can be a holder's name. */
async function mayListPasses(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
): Promise<boolean> {
  if (auth?.kind === 'api_key') return auth.scopes.includes('passes:read');
  if (auth?.kind !== 'session') return false;
  try {
    await tenantAuthorityOf(ctx, auth, orgId, 'passes:read');
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}

/** Releases and their versions never change, so what a release changed is worked out once per isolate. */
const CHANGES = new Map<string, { fromVersion: string | null; changes: ReleaseDiffGroup[] }>();
const CHANGES_MAX = 200;

async function releaseChanges(
  ctx: ServiceContext,
  templateId: string,
  release: { id: string; version: string; previousReleaseId: string | null },
) {
  const cached = CHANGES.get(release.id);
  if (cached) return cached;
  const previous = release.previousReleaseId
    ? await getRelease(ctx.env.DB, release.previousReleaseId)
    : null;
  const from = previous ? await getVersion(ctx.env.DB, templateId, previous.version) : null;
  const to = await getVersion(ctx.env.DB, templateId, release.version);
  const found = {
    fromVersion: previous?.version ?? null,
    changes: from && to ? groupedDiff(from, to) : [],
  };
  if (CHANGES.size >= CHANGES_MAX) CHANGES.delete(CHANGES.keys().next().value ?? '');
  CHANGES.set(release.id, found);
  return found;
}

function suggestion(name: string, rollback: boolean): string {
  const tail = rollback ? ' is back to an earlier design.' : ' has a new design.';
  return `${name.slice(0, TEXT_MAX - tail.length)}${tail}`;
}

/**
 * Read-only: where the approved release stands for the org's passes in one mode. A pass is left
 * behind when the rebuild recorded why, or when every rebuild of this release has finished (or none
 * ever started) and it is still not on it.
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
  const none = {
    releaseVersion: null,
    releaseId: null,
    fromVersion: null,
    total,
    onRelease: total,
    remaining: 0,
    updating: [],
    failedCount: 0,
    failed: [],
    startedAt: null,
    runId: null,
    running: false,
    stalled: false,
    changes: [],
    tell: null,
  } satisfies TemplateRollout;
  if (!release) return none;
  const input = { ...base, version: release.version, limit: total + 1 };
  const remaining = await countPassesNotOnVersion(ctx.env.DB, input);
  const runs = await rebuildsOf(ctx.env.DB, { ...base, releaseId: release.id });
  const running = runs.open > 0;
  const now = ctx.clock.now();
  const stalled = runs.n === 0 && remaining > 0 && now > release.createdAt + STALL_MS;
  const settled = remaining > 0 && !running && (runs.n > 0 || stalled);
  const left = { ...input, releaseId: release.id };
  const failedCount = settled ? remaining : await countRecordedFailures(ctx.env.DB, left);
  const listed =
    failedCount > 0 && (await mayListPasses(ctx, auth, query.orgId))
      ? await listLeftBehind(ctx.env.DB, { ...left, settled, limit: FAILED_SHOWN })
      : [];
  const updating = settled ? [] : await updatingByVersion(ctx.env.DB, left);
  const { fromVersion, changes } = await releaseChanges(ctx, templateId, release);
  const until = release.createdAt + TELL_WINDOW_MS;
  const onRelease = Math.max(0, total - remaining);
  const offered =
    now < until &&
    onRelease > 0 &&
    !(await tellSent(ctx.env.DB, { orgId: query.orgId, mode: query.mode, releaseId: release.id }));
  return {
    releaseVersion: release.version,
    releaseId: release.id,
    fromVersion,
    total,
    onRelease,
    remaining,
    updating: updating.map((u) => ({ version: u.version, count: u.n })),
    failedCount,
    failed: listed.map((p) => ({
      passId: p.id,
      title: p.title,
      reason: p.message ?? (stalled ? NO_REBUILD : LEFT_BEHIND),
    })),
    startedAt: release.createdAt,
    runId: runs.latestId,
    running,
    stalled,
    changes,
    tell: offered
      ? {
          text: suggestion(template.name, release.action === 'rollback'),
          until,
          key: `rollout-tell:${release.id}`,
        }
      : null,
  };
}
