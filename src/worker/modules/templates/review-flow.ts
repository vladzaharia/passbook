import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  ReleaseResult,
  ReviewResult,
  ReviewTemplate,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { isPreviewOnlyOrg } from '../developer/repo-fence.ts';
import { authorizeTemplateWrite, keyTestOnly } from './access.ts';
import { candidateHash as hashCandidate } from './release-content.ts';
import { ReviewRequiredError, releaseTemplate } from './release-flow.ts';
import { stepAuth } from './release-flow-plan.ts';
import { approveCandidate } from './releases.ts';
import { approvalMatches, currentPolicy, sealedDigest, snapshot } from './releases-candidate.ts';
import { scopedTemplate, writable } from './releases-domain.ts';
import { getVersion } from './repo.ts';
import { releasedCandidateIds } from './repo-release-state.ts';
import { type CandidateRow, listApprovals, listCandidates } from './repo-releases.ts';
import { newestRequestedVersion } from './repo-reviews.ts';

/**
 * A peer's review of a version: approves its open candidate in each mode that has one (Test and
 * Live for a person, Test for a Test key) and, with `release`, releases it when the caller may publish.
 * Approving one's own work is refused, except in a sandbox. Every refusal is decided before the first approval is written.
 */
export async function reviewTemplate(
  ctx: ServiceContext,
  auth: AuthContext,
  templateId: string,
  orgId: string,
  body: ReviewTemplate,
): Promise<ReviewResult> {
  if (auth.kind === 'api_key' && auth.mode !== 'test') throw keyTestOnly();
  const authority = await authorizeTemplateWrite(ctx, auth, orgId, 'templates:review');
  if (body.release && auth.kind === 'api_key') {
    // Why: the release step needs the same scopes `prepare` checks; refuse before an approval commits.
    const lacking = (['templates:write', 'templates:review', 'templates:publish'] as const).find(
      (scope) => !auth.scopes.includes(scope),
    );
    if (lacking)
      throw new ForbiddenError(`The API key lacks the ${lacking} scope.`, 'MISSING_SCOPE');
  }
  if (body.release)
    await authorizeTemplateWrite(
      ctx,
      stepAuth(auth, 'test', 'templates:publish'),
      orgId,
      'templates:publish',
    );
  const keyMode: Mode[] | null = auth.kind === 'api_key' ? [auth.mode] : null;
  const sandbox = await isPreviewOnlyOrg(ctx.env.DB, orgId);
  const modes: Mode[] = keyMode ?? (sandbox ? ['test'] : ['test', 'live']);
  const scope = { orgId, mode: modes[0] ?? 'test', provider: 'apple' } as const;
  const template = await scopedTemplate(
    ctx,
    stepAuth(auth, scope.mode, 'templates:review'),
    templateId,
    scope,
  );
  writable(template, scope);
  const version = await getVersion(ctx.env.DB, templateId, body.version);
  if (!version)
    throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
  const newest = await newestRequestedVersion(ctx.env.DB, templateId, orgId);
  if (newest !== null && newest !== body.version)
    throw new ConflictError(
      `Version ${newest} replaced this request. Review that version instead.`,
      'TEMPLATE_REVIEW_SUPERSEDED',
    );
  const { contentHash } = await sealedDigest(ctx, version);

  const plan: { mode: Mode; target: CandidateRow | null }[] = [];
  const ready: Mode[] = [];
  for (const mode of modes) {
    const where = { templateId, orgId, mode, provider: 'apple' as const };
    const released = await releasedCandidateIds(ctx.env.DB, templateId, orgId, mode);
    const open: CandidateRow[] = [];
    for (const c of (await listCandidates(ctx.env.DB, where)).sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    ))
      if (
        c.version === body.version &&
        !released.has(c.id) &&
        c.contentHash === contentHash &&
        currentPolicy(c) &&
        (await hashCandidate(snapshot(c))) === c.candidateHash
      )
        open.push(c);
    if (open.length === 0) continue;
    const approvals = await Promise.all(open.map((c) => listApprovals(ctx.env.DB, c.id)));
    ready.push(mode);
    if (
      open.some((c, i) =>
        (approvals[i] ?? []).some((a) => (sandbox || a.kind === 'peer') && approvalMatches(a, c)),
      )
    )
      continue;
    // A sandbox has one member, so the author may approve their own work there (Self-approved).
    const target = open.find(
      (c) => sandbox || (c.authorId !== authority.userId && c.versionAuthorId !== authority.userId),
    );
    if (!target)
      throw new ForbiddenError(
        'You wrote this version. Another reviewer must approve it.',
        'TEMPLATE_SELF_APPROVAL',
      );
    plan.push({ mode, target });
  }
  if (ready.length === 0)
    throw new NotFoundError(
      'No review was requested for this version. Ask the author to request one.',
      'TEMPLATE_REVIEW_NOT_FOUND',
    );
  const approved: Mode[] = [];
  for (const { mode, target } of plan) {
    if (!target) continue;
    await approveCandidate(ctx, stepAuth(auth, mode, 'templates:review'), templateId, target.id, {
      orgId,
      mode,
      provider: 'apple',
      candidateHash: target.candidateHash,
      ...(sandbox ? { alone: true } : {}),
    });
    approved.push(mode);
  }
  if (approved.length > 0)
    await recordAudit(ctx, {
      orgId,
      actorType: auth.kind === 'api_key' ? 'api_key' : 'user',
      actorId: auth.kind === 'api_key' ? auth.keyId : authority.userId,
      action: 'template.review',
      targetType: 'template',
      targetId: templateId,
      detail: { version: body.version, modes: approved, ...(body.note ? { note: body.note } : {}) },
    });
  let release: ReleaseResult | null = null;
  if (body.release)
    try {
      release = (await releaseTemplate(
        ctx,
        stepAuth(auth, 'test', 'templates:publish'),
        templateId,
        orgId,
        { orgId, version: body.version, modes: ready },
        {
          dryRun: false,
          scope: 'templates:publish',
          capability: 'templates:publish',
          request: false,
        },
      )) as ReleaseResult;
    } catch (error) {
      // Why: the approvals above are committed; the 409 says so.
      if (error instanceof ReviewRequiredError) error.approved = approved;
      throw error;
    }
  return { version: body.version, approved, release };
}
