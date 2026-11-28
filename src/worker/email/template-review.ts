import { TEMPLATE_REVIEW_COPY as COPY } from '../../shared/copy/template-review.ts';
import { safeUrl } from './safe.ts';
import { buttonHtml, EMAIL_LIGHT as c, emailShell, escapeHtml, titleHtml, type } from './shell.ts';

/** To the org's other reviewers when a template version is put up for review. */
export function templateReviewEmail(input: {
  base: string;
  link: string;
  template: string;
  version: string;
  by: string | null;
}) {
  const subject = COPY.subject(input.template);
  const body = COPY.body(input.by ?? COPY.fallbackName, input.template, input.version);
  const images = safeUrl(input.base) !== null;
  const html = `${titleHtml(escapeHtml(subject), '0 0 16px')}
<p style="margin:0 0 24px;${type('sm')};color:${c.text}" class="e-text">${escapeHtml(body)}</p>
${buttonHtml(input.link, COPY.action, true)}`;
  return {
    subject,
    text: `${subject}\n\n${body}\n\n${input.link}`,
    html: emailShell({
      lang: 'en',
      title: subject,
      header: 'PassBook',
      ...(images
        ? {
            headerMark: `${input.base}/apple-touch-icon.png`,
            buddy: { base: input.base, mood: 'curious' },
          }
        : {}),
      body: html,
    }),
  };
}
