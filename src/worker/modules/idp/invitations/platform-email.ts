import { PLATFORM_INVITE_EMAIL as copy } from '../../../../shared/copy/platform-invite.ts';
import { safeUrl } from '../../../email/safe.ts';
import {
  buttonHtml,
  EMAIL_LIGHT as c,
  emailShell,
  escapeHtml,
  titleHtml,
  type,
} from '../../../email/shell.ts';

export interface PlatformInvitationEmailInput {
  /** The invitation page; its fragment holds the secret. */
  link: string;
  /** PUBLIC_BASE_URL without the trailing slash. */
  base: string;
  developer: boolean;
  inviter?: string | null;
}

/** The platform invitation on the shared email shell. It holds no Polaris ID link: the page makes that on demand. */
export function platformInvitationEmail(input: PlatformInvitationEmailInput) {
  const line = copy.line(input.developer, input.inviter);
  const body = `${titleHtml(escapeHtml(copy.title), '0 0 8px')}
<p class="e-text" style="margin:0 0 24px;${type('sm')};color:${c.text}">${escapeHtml(line)}</p>
${buttonHtml(input.link, copy.button, true)}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${copy.footer}</p>`;
  const images = safeUrl(input.base) !== null;
  return {
    subject: copy.subject,
    text: [copy.subject, line, `${copy.button}: ${input.link}`, copy.footer].join('\n\n'),
    html: emailShell({
      lang: 'en',
      title: copy.subject,
      header: 'PassBook',
      ...(images
        ? {
            headerMark: `${input.base}/apple-touch-icon.png`,
            buddy: { base: input.base, mood: 'happy' },
          }
        : {}),
      body,
    }),
  };
}
