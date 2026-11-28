import { inviteLine } from '../../../shared/copy/invite.ts';
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
  /** With a sign-in `link`: the accept link for someone who already has an account. */
  acceptLink?: string;
  /** PUBLIC_BASE_URL without the trailing slash. */
  base: string;
  roles: readonly string[];
  /** The inviter's name, when they have one. */
  inviter?: string | null;
}

const NAME_MAX = 40;

/** The organization chooses its name and PassBook sends the mail: control characters out, long names cut. */
export function mailOrgName(name: string): string {
  const clean = name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX - 1).trimEnd()}…` : clean;
}

/** The invitation on the shared email shell; names the organization in the body only, never the token elsewhere. */
export function invitationEmail(rawInput: InvitationEmailInput) {
  const input = { ...rawInput, orgName: mailOrgName(rawInput.orgName) };
  const subject = 'You are invited to PassBook';
  const expiry = 'Expires in seven days. Ignore this email if you did not expect it.';
  const alt = Boolean(input.acceptLink);
  const line = inviteLine(input.orgName, input.roles, input.inviter);
  const body = `${titleHtml(`Join<br><span style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(input.orgName)}</span>`, '0 0 8px')}
<p class="e-text" style="margin:0 0 24px;${type('sm')};color:${c.text}">${escapeHtml(line)}</p>
${buttonHtml(input.link, 'Accept invitation', true)}
${alt ? `<p class="e-muted" style="margin:0 0 16px;${type('xs')};color:${c.muted}">Already have a PassBook account? <a class="e-link" href="${escapeHtml(input.acceptLink ?? '')}" style="color:${c.accent};text-decoration:underline">Accept here</a>.</p>\n` : ''}<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${expiry}</p>`;
  const images = safeUrl(input.base) !== null;
  return {
    subject,
    text: [
      subject,
      line,
      `Accept invitation: ${input.link}`,
      ...(alt ? [`Already have a PassBook account? Accept here: ${input.acceptLink}`] : []),
      expiry,
    ].join('\n\n'),
    html: emailShell({
      lang: 'en',
      title: subject,
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
