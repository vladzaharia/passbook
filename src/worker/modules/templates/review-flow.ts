import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  ReleaseResult,
  ReviewResult,
  ReviewTemplate,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { isPreviewOnlyOrg } from '../developer/repo-fence.ts';
import { authorizeTemplateWrite, keyTestOnly } from './access.ts';
import { releaseTemplate } from './release-flow.ts';
import { stepAuth } from './release-flow-plan.ts';
import { approveCandidate } from './releases.ts';
import { approvalMatches, currentPolicy } from './releases-candidate.ts';
import { scopedTemplate, writable } from './releases-domain.ts';
import { getVersion } from './repo.ts';
import { releasedCandidateIds } from './repo-release-state.ts';
import { listApprovals, listCandidates } from './repo-releases.ts';

/**
 * A peer's review of a version: approves its open candidate in each mode that has one (Test and
 * Live for a person, Test for a Test key) and, with `release`, releases it when the caller may publish.
 * Approving one's own work is refused by the approval grant.
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
  if (!(await getVersion(ctx.env.DB, templateId, body.version)))
    throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');

  const approved: Mode[] = [];
  for (const mode of modes) {
    const where = { templateId, orgId, mode, provider: 'apple' as const };
    const released = await releasedCandidateIds(ctx.env.DB, templateId, orgId, mode);
    const open = (await listCandidates(ctx.env.DB, where))
      .filter((c) => c.version === body.version && !released.has(c.id) && currentPolicy(c))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    if (open.length === 0) continue;
    const approvals = await Promise.all(open.map((c) => listApprovals(ctx.env.DB, c.id)));
    const done = open.some((c, i) =>
      (approvals[i] ?? []).some((a) => a.kind === 'peer' && approvalMatches(a, c)),
    );
    if (!done) {
      const own = (c: (typeof open)[number]) =>
        c.authorId === authority.userId || c.versionAuthorId === authority.userId;
      const target = open.find((c) => !own(c)) ?? open[0];
      if (!target) continue;
      await approveCandidate(ctx, stepAuth(auth, mode, 'templates:review'), templateId, target.id, {
        orgId,
        mode,
        provider: 'apple',
        candidateHash: target.candidateHash,
      });
    }
    approved.push(mode);
  }
  if (approved.length === 0)
    throw new NotFoundError(
      'No review was requested for this version. Ask the author to request one.',
      'TEMPLATE_REVIEW_NOT_FOUND',
    );
  await recordAudit(ctx, {
    orgId,
    actorType: auth.kind === 'api_key' ? 'api_key' : 'user',
    actorId: auth.kind === 'api_key' ? auth.keyId : authority.userId,
    action: 'template.review',
    targetType: 'template',
    targetId: templateId,
    detail: { version: body.version, modes: approved, ...(body.note ? { note: body.note } : {}) },
  });
  const release = body.release
    ? ((await releaseTemplate(
        ctx,
        auth,
        templateId,
        orgId,
        { orgId, version: body.version, modes: approved },
        {
          dryRun: false,
          scope: 'templates:publish',
          capability: 'templates:publish',
          request: false,
        },
      )) as ReleaseResult)
    : null;
  return { version: body.version, approved, release };
}
