import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
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

/** Tells every org admin that a retention class shortens, and when. */
export async function sendShortenNotices(
  ctx: ServiceContext,
  notices: ShortenNotice[],
): Promise<void> {
  const base = baseUrl(ctx.env);
  for (const n of notices) await toAdmins(ctx, n.orgId, shortenEmail(base, n.cls, n.days, n.from));
}

export const sendHoldNotice = (ctx: ServiceContext, orgId: string, placed: boolean) =>
  toAdmins(ctx, orgId, holdEmail(baseUrl(ctx.env), placed));
