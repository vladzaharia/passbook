import { DEVELOPER_INVITE_EMAIL as copy } from '../../../shared/copy/developer-invite.ts';
import { safeUrl } from '../../email/safe.ts';
import {
  buttonHtml,
  EMAIL_LIGHT as c,
  emailShell,
  escapeHtml,
  titleHtml,
  type,
} from '../../email/shell.ts';
import { mailOrgName } from '../orgs/invitation-email.ts';

export interface DeveloperInvitationEmailInput {
  orgName: string;
  /** The accept page; its fragment holds the secret. */
  link: string;
  /** PUBLIC_BASE_URL without the trailing slash. */
  base: string;
  roles: readonly string[];
  inviter?: string | null;
}

/** The developer invitation on the shared email shell. It holds no Polaris ID link: the page makes that on demand. */
export function developerInvitationEmail(rawInput: DeveloperInvitationEmailInput) {
  const input = { ...rawInput, orgName: mailOrgName(rawInput.orgName) };
  const subject = copy.subject(input.orgName);
  const line = copy.line(input.orgName, input.roles, input.inviter);
  const body = `${titleHtml(escapeHtml(copy.title(input.orgName)), '0 0 8px')}
<p class="e-text" style="margin:0 0 24px;${type('sm')};color:${c.text}">${escapeHtml(line)}</p>
${buttonHtml(input.link, copy.button, true)}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${copy.footer}</p>`;
  const images = safeUrl(input.base) !== null;
  return {
    subject,
    text: [subject, line, `${copy.button}: ${input.link}`, copy.footer].join('\n\n'),
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
