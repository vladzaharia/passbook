import { safeUrl } from './safe.ts';
import { buttonHtml, EMAIL_LIGHT as c, emailShell, escapeHtml, titleHtml, type } from './shell.ts';

export interface ReplyToConfirmInput {
  orgName: string;
  address: string;
  link: string;
}

/** The link that confirms an address as an org's reply-to. */
export function renderReplyToConfirm(input: ReplyToConfirmInput) {
  const subject = 'Confirm your reply-to address';
  const title = `Use ${input.address} for replies`;
  const note = `${input.orgName} asked to send replies to pass emails to this address. The link works once and expires in 24 hours. Ignore this email if you did not expect it.`;
  const link = safeUrl(input.link) ?? '';
  const body = `${titleHtml(escapeHtml(title), '0 0 16px')}
<p class="e-text" style="margin:0 0 24px;${type('sm')};color:${c.text}">${escapeHtml(note)}</p>
${link ? buttonHtml(link, 'Confirm address', true) : ''}`;
  return {
    subject,
    html: emailShell({ lang: 'en', title: subject, header: 'PassBook', body }),
    text: [title, note, `Confirm address: ${link}`].join('\n\n'),
  };
}
