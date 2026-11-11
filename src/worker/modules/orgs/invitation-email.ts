import { safeUrl } from '../../email/safe.ts';
import {
  buttonHtml,
  EMAIL_LIGHT as c,
  emailShell,
  escapeHtml,
  titleHtml,
  type,
} from '../../email/shell.ts';

export interface InvitationEmailInput {
  orgName: string;
  /** The accept link; its fragment holds the secret. */
  link: string;
  /** PUBLIC_BASE_URL without the trailing slash. */
  base: string;
}

/** The invitation on the shared email shell; names the organization, never the token elsewhere. */
export function invitationEmail(input: InvitationEmailInput) {
  const subject = `Join ${input.orgName} on PassBook`;
  const expiry = 'Expires in seven days. Ignore this email if you did not expect it.';
  const body = `${titleHtml(escapeHtml(subject), '0 0 24px')}
${buttonHtml(input.link, 'Accept invitation', true)}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${expiry}</p>`;
  const images = safeUrl(input.base) !== null;
  return {
    subject,
    text: [subject, `Accept invitation: ${input.link}`, expiry].join('\n\n'),
    html: emailShell({
      lang: 'en',
      title: subject,
      header: 'PassBook',
      ...(images
        ? {
            headerMark: `${input.base}/apple-touch-icon.png`,
            buddy: { base: input.base, mood: 'happy', tier: 'l' },
          }
        : {}),
      body,
    }),
  };
}
