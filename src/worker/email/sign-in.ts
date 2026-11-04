import type { MagicPrefer } from '../../shared/contracts/session.ts';
import type { EmailMood } from '../../shared/email-art.ts';
import { safeUrl } from './safe.ts';
import {
  buttonHtml,
  EMAIL_LIGHT as c,
  emailShell,
  escapeHtml,
  MONO,
  RADIUS,
  titleHtml,
  type,
} from './shell.ts';

export interface SignInEmailInput {
  purpose: 'sign_in' | 'verify_email';
  link: string;
  /** PUBLIC_BASE_URL without the trailing slash: the header images live under it. */
  base: string;
  /** Present for sign_in only. */
  code?: string;
  expiresMinutes: number;
  /** verify_email: the account that asked for this address. */
  requester?: string;
  /** sign_in: `code` leads with the code (asked from the installed app). Layout only. */
  prefer?: MagicPrefer;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** A link sent: happy. Confirming an address someone added: curious. */
export const SIGN_IN_MOOD: Record<SignInEmailInput['purpose'], EmailMood> = {
  sign_in: 'happy',
  verify_email: 'curious',
};

/**
 * The code is a letter-spaced chip, not a field: easy to read, nothing to type into. Leading, it
 * is the email's action: larger, and a block as wide as the button it stands in for.
 */
function chipHtml(code: string, lead: boolean): string {
  // Centred, the left padding gains the letter-spacing the last digit trails.
  const look = lead
    ? 'display:block;padding:14px 16px 14px 24px;text-align:center'
    : 'display:inline-block;padding:10px 16px';
  const size = lead
    ? 'font-size:32px;line-height:40px;font-weight:600;letter-spacing:8px'
    : 'font-size:24px;line-height:28px;font-weight:600;letter-spacing:6px';
  return `<p style="margin:0 0 24px"><span class="e-chip e-strong" style="${look};border-radius:${RADIUS.md}px;background:${c.sunken};font-family:${MONO};${size};color:${c.strong}">${escapeHtml(code)}</span></p>`;
}

const orLine = (line: string) =>
  `<p class="e-muted" style="margin:0 0 8px;${type('sm')};color:${c.muted}">${line}</p>`;

export function renderSignInEmail(input: SignInEmailInput): RenderedEmail {
  const verify = input.purpose === 'verify_email';
  // From the installed app a link opens the browser, not the app, so the code leads.
  const codeFirst = !verify && input.code !== undefined && input.prefer === 'code';
  const subject = verify
    ? 'Confirm your email'
    : codeFirst
      ? 'Your sign-in code'
      : 'Your sign-in link';
  const title = verify ? 'Confirm your email' : codeFirst ? subject : 'Sign in to PassBook';
  const action = verify ? 'Confirm email' : 'Sign in';
  const expiry = `Expires in ${input.expiresMinutes} minutes. Ignore this email if you did not ask for it.`;
  const askedBy =
    verify && input.requester ? `Adds this address to the account of ${input.requester}.` : '';

  const lines = codeFirst
    ? [title, input.code, `Or open this link: ${input.link}`, expiry]
    : [title, askedBy, `${action}: ${input.link}`, input.code ? `Code: ${input.code}` : '', expiry];
  const text = lines.filter(Boolean).join('\n\n');

  const button = (primary: boolean) => buttonHtml(input.link, action, primary);
  const actions = codeFirst
    ? `${chipHtml(input.code ?? '', true)}\n${orLine('Or open this link')}\n${button(false)}`
    : `${button(true)}\n${input.code ? `${orLine('Or enter this code')}\n${chipHtml(input.code, false)}` : ''}`;
  const body = `${titleHtml(title, `0 0 ${askedBy ? '8' : '24'}px`)}
${askedBy ? `<p class="e-text" style="margin:0 0 24px;${type('sm')};color:${c.text}">${escapeHtml(askedBy)}</p>` : ''}
${actions}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${expiry}</p>`;

  // Images need an absolute URL; without one the band shows the word alone.
  const images = safeUrl(input.base) !== null;
  return {
    subject,
    html: emailShell({
      lang: 'en',
      title: subject,
      header: 'PassBook',
      ...(images
        ? {
            headerMark: `${input.base}/apple-touch-icon.png`,
            buddy: { base: input.base, mood: SIGN_IN_MOOD[input.purpose], tier: 'l' },
          }
        : {}),
      body,
    }),
    text,
  };
}
