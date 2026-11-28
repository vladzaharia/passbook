import { ORG_LIFECYCLE_COPY as COPY } from '../../shared/copy/org-lifecycle.ts';
import { safeUrl } from './safe.ts';
import { EMAIL_LIGHT as c, emailShell, escapeHtml, titleHtml, type } from './shell.ts';

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function notice(base: string, subject: string, body: string): Rendered {
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
        ? {
            headerMark: `${base}/apple-touch-icon.png`,
            buddy: { base, mood: 'curious' },
          }
        : {}),
      body: html,
    }),
  };
}

/** To every org admin when the org closes. `purgeDate` is the day after which the data is removed. */
export const orgClosedEmail = (base: string, org: string, purgeDate: string): Rendered =>
  notice(base, COPY.closedSubject(org), COPY.closedBody(org, purgeDate));

export const orgReopenedEmail = (base: string, org: string): Rendered =>
  notice(base, COPY.reopenedSubject(org), COPY.reopenedBody(org));
