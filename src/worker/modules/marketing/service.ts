import {
  type AccessRequest,
  AccessRequestSchema,
} from '../../../shared/contracts/access-request.ts';
import { ACCESS_COPY } from '../../../shared/copy/access.ts';
import { strictEmail } from '../../../shared/email.ts';
import { accessRequestEmail } from '../../email/access-request.ts';
import { UnavailableError, ValidationError, zodIssues } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer, type Mailer } from '../delivery/mailer.ts';

const unavailable = () => new UnavailableError(ACCESS_COPY.unavailable, 'ACCESS_MAIL_UNAVAILABLE');

/** The honeypot field: a person never sees it, so a value in it is a script. */
const trapped = (input: Record<string, unknown>) =>
  typeof input.website === 'string' && input.website.trim() !== '';

/**
 * One Request access post: validates, mails PassBook's inbox. The honeypot answers as a success
 * without sending, the only path that does. A missing binding, invalid recipient or failed send
 * is a 503, never a success. Logs carry the purpose and field paths, never what was typed.
 */
export async function submitAccessRequest(
  ctx: ServiceContext,
  input: Record<string, unknown>,
  mailer?: Mailer,
): Promise<void> {
  if (trapped(input)) {
    ctx.log.info('marketing.access_trap', { code: 'ACCESS_TRAP' });
    return;
  }
  const parsed = AccessRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error);
    ctx.log.info('marketing.access_invalid', {
      code: 'ACCESS_INVALID',
      fields: issues.map((issue) => issue.path),
    });
    throw new ValidationError(issues[0]?.message ?? ACCESS_COPY.invalid, issues);
  }
  const request: AccessRequest = parsed.data;
  const to = strictEmail((ctx.env as { ACCESS_REQUEST_EMAIL?: unknown }).ACCESS_REQUEST_EMAIL);
  const binding = (ctx.env as { EMAIL?: { send?: unknown } }).EMAIL;
  if (to === null || (!mailer && typeof binding?.send !== 'function')) {
    ctx.log.error('marketing.access_unconfigured', { code: 'ACCESS_MAIL_UNCONFIGURED' });
    throw unavailable();
  }
  const mail = accessRequestEmail(request);
  try {
    await (mailer ?? createEmailBindingMailer(ctx.env)).send({
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      replyTo: request.email,
    });
  } catch {
    // The provider's text can echo the message; only the code is logged.
    ctx.log.error('marketing.access_failed', { code: 'ACCESS_MAIL_FAILED' });
    throw unavailable();
  }
  ctx.log.info('marketing.access_sent', {
    code: 'ACCESS_SENT',
    purpose: request.purpose,
    hasMessage: request.message !== '',
  });
}
