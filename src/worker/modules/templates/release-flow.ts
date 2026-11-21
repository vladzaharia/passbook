import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  ReleasePlan,
  ReleaseResult,
  ReleaseTemplate,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TemplateCapability } from './access.ts';
import { type Prepared, pickCandidate } from './release-flow-pick.ts';
import {
  buildPlan,
  planMode,
  prepare,
  type StepScope,
  scopeOf,
  stepAuth,
} from './release-flow-plan.ts';
import { loadReleaseState } from './release-state-facts.ts';
import { approveCandidate, createCandidate, publishRelease } from './releases.ts';
import { listVersions } from './repo.ts';

type ModeResult = NonNullable<ReleaseResult['modes'][Mode]>;

/** 409 `TEMPLATE_REVIEW_REQUIRED`: the caller cannot approve this version alone. The route adds `plan`. */
export class ReviewRequiredError extends ConflictError {
  readonly plan: ReleasePlan;
  constructor(plan: ReleasePlan, mode: Mode) {
    super(
      `Another reviewer must approve this version before it is released in ${mode === 'live' ? 'Live' : 'Test'}.`,
      'TEMPLATE_REVIEW_REQUIRED',
    );
    this.plan = plan;
  }
}

/** Called with the candidates a review request created or reused; T3 sends the reviewers' email here. */
export type ReviewRequested = (
  ctx: ServiceContext,
  info: { templateId: string; orgId: string; version: string; candidateIds: string[] },
) => Promise<void>;

export interface ReleaseFlowOptions {
  dryRun: boolean;
  /** What the route declared: publish for a release, author for a review request. */
  scope: StepScope;
  capability: TemplateCapability;
  request: boolean;
  onReviewRequested?: ReviewRequested;
}

async function reviewRequired(
  ctx: ServiceContext,
  p: Prepared,
  mode: Mode,
): Promise<ReviewRequiredError> {
  return new ReviewRequiredError(await buildPlan(ctx, p), mode);
}

/** One mode: candidate, approval, release. Each step is its own grant, so a refusal leaves the earlier steps. */
async function runMode(
  ctx: ServiceContext,
  p: Prepared,
  mode: Mode,
  requested: string[],
): Promise<ModeResult> {
  const { plan, head } = await planMode(ctx, p, mode);
  if (plan.outcome === 'current' || plan.outcome === 'kept')
    return {
      outcome: plan.outcome,
      releaseId: head?.id ?? null,
      generation: plan.expectedGeneration,
      approvalKind: null,
    };
  const scope = scopeOf(p, mode);
  let picked = await pickCandidate(ctx, p, mode);
  if (!picked) {
    await createCandidate(
      ctx,
      stepAuth(p.auth, mode, 'templates:write'),
      p.templateId,
      { ...scope, version: p.version.version },
      { liveRequest: p.request },
    );
    // Why: a racing call may have made one too; both settle on the oldest, or on one already approved.
    picked = await pickCandidate(ctx, p, mode);
  }
  if (!picked)
    throw new ConflictError(
      'The template release changed. Reload and retry.',
      'TEMPLATE_RELEASE_CONFLICT',
    );
  const row = picked.candidate;
  if (p.request) {
    requested.push(row.id);
    return {
      outcome: 'review_requested',
      releaseId: null,
      generation: plan.expectedGeneration,
      approvalKind: null,
    };
  }
  let approval = picked.approval;
  if (!approval) {
    if (plan.approval.action === 'needed') throw await reviewRequired(ctx, p, mode);
    try {
      const written = await approveCandidate(
        ctx,
        stepAuth(p.auth, mode, 'templates:review'),
        p.templateId,
        row.id,
        { ...scope, candidateHash: row.candidateHash, alone: true },
      );
      approval = { ...written, kind: written.kind ?? 'peer' };
    } catch (error) {
      // Why: a reviewer added since the plan was made takes the sole rule away (the grant refuses it
      // as a conflict); the caller needs a review.
      const lostSole =
        mode === 'live' &&
        ((error instanceof ForbiddenError && error.code === 'TEMPLATE_SELF_APPROVAL') ||
          (error instanceof ConflictError && error.code === 'TEMPLATE_RELEASE_CONFLICT'));
      if (lostSole) throw await reviewRequired(ctx, p, mode);
      throw error;
    }
  }
  const released = await publishRelease(
    ctx,
    stepAuth(p.auth, mode, 'templates:publish'),
    p.templateId,
    {
      ...scope,
      candidateId: row.id,
      approvalId: approval.id,
      candidateHash: row.candidateHash,
      expectedGeneration: plan.expectedGeneration,
    },
  );
  return {
    outcome: 'released',
    releaseId: released.id,
    generation: released.generation,
    approvalKind: approval.kind,
  };
}

/**
 * Releases a version in one call: Test first, then Live. Without `dryRun` it returns the result, and a
 * mode that needs another reviewer ends in `ReviewRequiredError`; Test stays released and the next call resumes.
 */
export async function releaseTemplate(
  ctx: ServiceContext,
  auth: AuthContext,
  templateId: string,
  orgId: string,
  body: ReleaseTemplate,
  options: ReleaseFlowOptions,
): Promise<ReleasePlan | ReleaseResult> {
  const p = await prepare(ctx, auth, templateId, orgId, body, {
    scope: options.scope,
    capability: options.capability,
    request: options.request || body.request === true,
  });
  if (options.dryRun) return buildPlan(ctx, p);
  const modes: ReleaseResult['modes'] = {};
  const requested: string[] = [];
  for (const mode of p.modes) modes[mode] = await runMode(ctx, p, mode, requested);
  if (requested.length > 0)
    await options.onReviewRequested?.(ctx, {
      templateId,
      orgId,
      version: p.version.version,
      candidateIds: requested,
    });
  return {
    version: p.version.version,
    modes,
    state: await loadReleaseState(
      ctx,
      auth,
      templateId,
      orgId,
      await listVersions(ctx.env.DB, templateId),
    ),
  };
}
