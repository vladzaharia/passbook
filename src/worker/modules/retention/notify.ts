import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import type { ShortenNotice } from './changes.ts';
import { holdEmail, shortenEmail } from './email.ts';
import { readOrgAdminEmails } from './repo.ts';

type Rendered = { subject: string; html: string; text: string };

/** Best effort: the change is already committed. A failure is logged by org, never by address. */
async function toAdmins(ctx: ServiceContext, orgId: string, message: Rendered): Promise<void> {
  const mailer = createEmailBindingMailer(ctx.env);
  for (const to of await readOrgAdminEmails(ctx.env.DB, orgId)) {
    try {
      await mailer.send({ to, ...message });
    } catch {
      // Provider errors can carry message content, so none is logged.
      ctx.log.error('retention.notice_failed', { orgId, code: 'RETENTION_NOTICE_FAILED' });
    }
  }
}

const SEND_BATCH = 100;

/**
 * Queues one notice job per org and class: a platform change may reach hundreds of orgs, too many mails for
 * one request. A queue failure is logged; the floor already protects the data.
 */
export async function enqueueShortenNotices(
  ctx: ServiceContext,
  notices: ShortenNotice[],
): Promise<void> {
  for (let i = 0; i < notices.length; i += SEND_BATCH) {
    try {
      await ctx.env.JOBS.sendBatch(
        notices
          .slice(i, i + SEND_BATCH)
          .map((n) => ({ body: { kind: 'retention.notice' as const, ...n } })),
      );
    } catch (error) {
      ctx.log.error('retention.notice_enqueue_failed', {
        code: 'RETENTION_NOTICE_ENQUEUE_FAILED',
        error,
      });
    }
  }
}

/** The queue job: mails the org's admins. */
export const sendShortenNotice = async (ctx: ServiceContext, n: ShortenNotice) =>
  toAdmins(
    ctx,
    n.orgId,
    shortenEmail(
      baseUrl(ctx.env),
      n.cls,
      n.days,
      n.from,
      await readOrgTimeZone(ctx.env.DB, n.orgId),
    ),
  );

export const sendHoldNotice = (ctx: ServiceContext, orgId: string, placed: boolean) =>
  toAdmins(ctx, orgId, holdEmail(baseUrl(ctx.env), placed));
