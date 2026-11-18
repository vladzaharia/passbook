import { PRIVACY_COPY } from '../../../shared/copy/privacy.ts';
import type { RetentionClass } from '../../../shared/privacy/data-classes.ts';
import { safeUrl } from '../../email/safe.ts';
import { EMAIL_LIGHT as c, emailShell, escapeHtml, titleHtml, type } from '../../email/shell.ts';

/** A short notice to org admins on the shared email shell. */
export function noticeEmail(base: string, subject: string, body: string) {
  const html = `${titleHtml(escapeHtml(subject), '0 0 16px')}
<p style="margin:0;${type('sm')};color:${c.text}" class="e-text">${escapeHtml(body)}</p>`;
  const images = safeUrl(base) !== null;
  return {
    subject,
    text: `${subject}\n\n${body}`,
    html: emailShell({
      lang: 'en',
      title: subject,
      header: 'PassBook',
      ...(images
        ? { headerMark: `${base}/apple-touch-icon.png`, buddy: { base, mood: 'happy', tier: 'l' } }
        : {}),
      body: html,
    }),
  };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function shortenEmail(base: string, cls: RetentionClass, days: number, from: number) {
  return noticeEmail(
    base,
    PRIVACY_COPY.retentionEmailSubject(cls, days),
    PRIVACY_COPY.retentionEmailBody(cls, days, day(from)),
  );
}

export const holdEmail = (base: string, placed: boolean) =>
  placed
    ? noticeEmail(base, PRIVACY_COPY.holdOrgEmailSubject, PRIVACY_COPY.holdOrgEmailBody)
    : noticeEmail(base, PRIVACY_COPY.holdReleaseEmailSubject, PRIVACY_COPY.holdReleaseEmailBody);
