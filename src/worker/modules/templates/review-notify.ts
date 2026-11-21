import { templateReviewEmail } from '../../email/template-review.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
import type { ReviewRequested } from './release-flow.ts';
import { getTemplate } from './repo.ts';
import { userNames } from './repo-release-names.ts';
import { getCandidate } from './repo-releases.ts';
import { olderOpenVersions, reviewerEmails } from './repo-reviews.ts';

/**
 * After a review request: records it (naming the older requests it supersedes) and tells the org's
 * other reviewers. Best effort: the request is committed, and a mail failure logs a code, never an address.
 */
export const notifyReviewers: ReviewRequested = async (ctx: ServiceContext, info) => {
  const candidate = await getCandidate(ctx.env.DB, info.candidateIds[0] ?? '');
  const template = await getTemplate(ctx.env.DB, info.templateId);
  if (!candidate || !template) return;
  await recordAudit(ctx, {
    orgId: info.orgId,
    actorType: 'user',
    actorId: candidate.authorId,
    action: 'template.review_requested',
    targetType: 'template',
    targetId: info.templateId,
    detail: {
      version: info.version,
      superseded: await olderOpenVersions(ctx.env.DB, info.templateId, info.orgId, info.version),
    },
  });
  // A developer org sends no real mail; the audit row above is its record.
  if (await isPreviewOnlyOrg(ctx.env.DB, info.orgId)) return;
  const [emails, names] = await Promise.all([
    reviewerEmails(ctx.env.DB, info.orgId, candidate.authorId),
    userNames(ctx.env.DB, [candidate.authorId], info.orgId, false),
  ]);
  const base = baseUrl(ctx.env);
  const message = templateReviewEmail({
    base,
    link: `${base}/admin/templates/${info.templateId}`,
    template: template.name,
    version: info.version,
    by: names.get(candidate.authorId) ?? null,
  });
  const mailer = createEmailBindingMailer(ctx.env);
  for (const to of emails) {
    try {
      await mailer.send({ to, ...message });
    } catch {
      ctx.log.error('template.review_notice_failed', {
        orgId: info.orgId,
        code: 'TEMPLATE_REVIEW_NOTICE_FAILED',
      });
    }
  }
};
