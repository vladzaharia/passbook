import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  ReleaseModePlan,
  ReleasePlan,
  ReleaseTemplate,
} from '../../../shared/contracts/template-releases.ts';
import { isAlone } from '../../../shared/template-release-state.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { verifiedScopes } from '../../platform/auth-capability.ts';
import { viaToken } from '../../platform/auth-workbench.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  orgTestOnly,
  workbenchTestOnly,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isPreviewOnlyOrg } from '../developer/repo-fence.ts';
import {
  authorizeTemplateWrite,
  keyTestOnly,
  type TemplateAuthority,
  type TemplateCapability,
} from './access.ts';
import { groupedDiff } from './release-flow-diff.ts';
import { type Prepared, pickCandidate } from './release-flow-pick.ts';
import { COUNT_CAP } from './release-impact.ts';
import { loadReleaseState } from './release-state-facts.ts';
import { sealedDigest } from './releases-candidate.ts';
import { changed, scopedTemplate, writable } from './releases-domain.ts';
import { getVersion, listVersions } from './repo.ts';
import { countDevicesNotOnVersion, countPassesNotOnVersion } from './repo-release-impact.ts';
import { isActiveReviewer } from './repo-release-state.ts';
import { getActiveRelease, type ReleaseRow } from './repo-releases.ts';
import { countEligibleReviewers } from './repo-sole-reviewer.ts';

/** The scope each step's grant is checked under: a key acts with exactly the scope of that step. */
export type StepScope = 'templates:write' | 'templates:review' | 'templates:publish';

/**
 * The principal for one mode's step. A session adopts the mode, and a key stays in its own (Test)
 * with the verified scope of the step, as `requireCaller` tags it for the step's own route.
 */
export function stepAuth(auth: AuthContext, mode: Mode, scope: StepScope): AuthContext {
  if (auth.kind === 'api_key') {
    if (auth.mode !== mode) throw keyTestOnly();
    if (!auth.scopes.includes(scope))
      throw new ForbiddenError(`The API key lacks the ${scope} scope.`, 'MISSING_SCOPE');
    const step = { ...auth };
    verifiedScopes.set(step, scope);
    return step;
  }
  return auth.kind === 'session' && auth.mode !== mode ? { ...auth, mode } : auth;
}

async function holder(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  scope: StepScope,
  capability: TemplateCapability,
): Promise<string | null> {
  try {
    return (await authorizeTemplateWrite(ctx, stepAuth(auth, 'test', scope), orgId, capability))
      .userId;
  } catch (error) {
    // Why: a missing role or key scope is the answer "can't"; any other refusal is a real failure.
    if (
      error instanceof ForbiddenError &&
      ['FORBIDDEN', 'MISSING_SCOPE', 'KEY_TEST_ONLY', 'KEY_CREATOR_NOT_MEMBER'].includes(error.code)
    )
      return null;
    throw error;
  }
}

/**
 * Checks the request once: the route's own capability, the template, the version and the modes.
 * `capability` is what the route declared (publish for a release, author for a review request).
 */
export async function prepare(
  ctx: ServiceContext,
  auth: AuthContext,
  templateId: string,
  orgId: string,
  body: ReleaseTemplate,
  route: { scope: StepScope; capability: TemplateCapability; request: boolean },
): Promise<Prepared> {
  const liveKey = auth.kind === 'api_key' && auth.mode === 'live';
  // Why: a Live key may only request review (D3); every other call needs a Test key.
  if (liveKey && !route.request) throw keyTestOnly();
  const authority: TemplateAuthority = await authorizeTemplateWrite(
    ctx,
    auth,
    orgId,
    route.capability,
    { liveRequest: route.request },
  );
  if (auth.kind === 'api_key') {
    const needed: StepScope[] = route.request
      ? ['templates:write']
      : ['templates:write', 'templates:review', 'templates:publish'];
    const lacking = needed.find((scope) => !auth.scopes.includes(scope));
    if (lacking)
      throw new ForbiddenError(`The API key lacks the ${lacking} scope.`, 'MISSING_SCOPE');
  }
  const sandbox = await isPreviewOnlyOrg(ctx.env.DB, orgId);
  const keyMode: Mode[] | null = auth.kind === 'api_key' ? [auth.mode] : null;
  // A Workbench token releases to Test only: `modes` defaults to `['test']` and may not name Live.
  const token = viaToken(auth);
  const wanted =
    body.modes ??
    keyMode ??
    (sandbox || token ? (['test'] as Mode[]) : (['live', 'test'] as Mode[]));
  if (token && wanted.includes('live')) throw workbenchTestOnly();
  if (keyMode && wanted.some((m) => !keyMode.includes(m))) throw keyTestOnly();
  if (wanted.includes('live') && sandbox) throw orgTestOnly();
  const modes = (['test', 'live'] as const).filter((m) => wanted.includes(m));
  const scope = { orgId, mode: modes[0] ?? 'test', provider: 'apple' } as const;
  const template = await scopedTemplate(
    ctx,
    stepAuth(auth, scope.mode, route.scope),
    templateId,
    scope,
  );
  writable(template, scope);
  const version = await getVersion(ctx.env.DB, templateId, body.version);
  if (!version)
    throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
  if (!version.report.ok)
    throw new ConflictError('The template version is invalid.', 'VERSION_INVALID');
  const [author, review, publish, count] = await Promise.all([
    route.request && liveKey
      ? Promise.resolve(authority.userId)
      : holder(ctx, auth, orgId, 'templates:write', 'templates:author'),
    holder(ctx, auth, orgId, 'templates:review', 'templates:review'),
    holder(ctx, auth, orgId, 'templates:publish', 'templates:publish'),
    countEligibleReviewers(ctx.env.DB, orgId),
  ]);
  const userId = author ?? authority.userId;
  const includesCaller = review !== null && (await isActiveReviewer(ctx.env.DB, orgId, review));
  return {
    auth,
    orgId,
    templateId,
    version,
    contentHash: (await sealedDigest(ctx, version)).contentHash,
    modes,
    request: route.request,
    expected: body.expected ?? {},
    userId,
    canReview: review !== null,
    alone: isAlone({
      caller: {
        userId,
        author: author !== null,
        review: review !== null,
        publish: publish !== null,
      },
      reviewers: { count, includesCaller },
    }),
  };
}

export function scopeOf(p: Prepared, mode: Mode) {
  return { orgId: p.orgId, mode, provider: 'apple' as const };
}

async function impactOf(ctx: ServiceContext, p: Prepared, mode: Mode) {
  const input = {
    templateId: p.templateId,
    orgId: p.orgId,
    mode,
    version: p.version.version,
    limit: COUNT_CAP + 1,
  };
  const [passes, devices] = await Promise.all([
    countPassesNotOnVersion(ctx.env.DB, input),
    countDevicesNotOnVersion(ctx.env.DB, input),
  ]);
  const cap = (n: number) => ({ count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP });
  return { passes: cap(passes), devices: cap(devices) };
}

export type ModeState = { plan: ReleaseModePlan; head: ReleaseRow | null };

/** What one mode would do now. Test follows Live: a newer Test head stays unless Test is named alone. */
export async function planMode(ctx: ServiceContext, p: Prepared, mode: Mode): Promise<ModeState> {
  const db = ctx.env.DB;
  const heads = Object.fromEntries(
    await Promise.all(
      (['live', 'test'] as const).map(
        async (m) =>
          [m, await getActiveRelease(db, { templateId: p.templateId, ...scopeOf(p, m) })] as const,
      ),
    ),
  ) as Record<Mode, ReleaseRow | null>;
  const head = heads[mode];
  const generation = head?.generation ?? 0;
  const { version } = p.version;
  const current = head?.version === version;
  const expected = p.expected[mode];
  // Why: a mode already at this version is a resumed call; its earlier `expected` no longer applies.
  if (!current && expected !== undefined && expected !== generation) throw changed();
  const headVersion =
    mode === 'test' && head && !current ? await getVersion(db, p.templateId, head.version) : null;
  const ahead =
    !p.request &&
    p.modes.includes('live') &&
    headVersion !== null &&
    headVersion.createdAt > p.version.createdAt;
  const following = !ahead;
  const picked = await pickCandidate(ctx, p, mode);
  const approval = picked?.approval ?? null;
  const write: ReleaseModePlan['approval'] =
    mode === 'test'
      ? p.canReview
        ? { action: 'write', kind: 'test' }
        : { action: 'needed', kind: null }
      : p.alone
        ? { action: 'write', kind: 'sole' }
        : { action: 'needed', kind: null };
  const settled = current || !following;
  return {
    head,
    plan: {
      outcome: current
        ? 'current'
        : !following
          ? 'kept'
          : p.request
            ? 'review_requested'
            : write.action === 'needed' && !approval
              ? 'review_required'
              : 'release',
      from: head?.version ?? null,
      expectedGeneration: generation,
      candidate: { action: picked ? 'reuse' : 'create', id: picked?.candidate.id ?? null },
      approval: approval ? { action: 'reuse', kind: approval.kind } : write,
      impact: settled
        ? { passes: { count: 0, capped: false }, devices: { count: 0, capped: false } }
        : await impactOf(ctx, p, mode),
    },
  };
}

/** The dry run: every mode's steps, the typed diff and the state as the caller sees it. */
export async function buildPlan(ctx: ServiceContext, p: Prepared): Promise<ReleasePlan> {
  const states = await Promise.all(p.modes.map((m) => planMode(ctx, p, m)));
  const live = p.modes.indexOf('live');
  const from = states[Math.max(live, 0)]?.head ?? null;
  const fromRow = from ? await getVersion(ctx.env.DB, p.templateId, from.version) : null;
  const versions = await listVersions(ctx.env.DB, p.templateId);
  return {
    version: p.version.version,
    modes: Object.fromEntries(p.modes.map((m, i) => [m, states[i]?.plan])),
    diff: groupedDiff(fromRow, p.version),
    fromVersion: from?.version ?? null,
    state: await loadReleaseState(ctx, p.auth, p.templateId, p.orgId, versions),
  };
}
