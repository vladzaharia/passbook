import type { EmailMood } from '../../shared/email-art.ts';
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

// Images need an absolute URL; without one the band shows the word alone.
const absolute = (base: string) => /^https?:\/\/[^\s"'<>]+$/i.test(base);

export function renderSignInEmail(input: SignInEmailInput): RenderedEmail {
  const verify = input.purpose === 'verify_email';
  const subject = verify ? 'Confirm your email' : 'Your sign-in link';
  const title = verify ? 'Confirm your email' : 'Sign in to PassBook';
  const action = verify ? 'Confirm email' : 'Sign in';
  const expiry = `Expires in ${input.expiresMinutes} minutes. Ignore this email if you did not ask for it.`;
  const codeLine = input.code ? `Code: ${input.code}` : '';
  const askedBy =
    verify && input.requester ? `Adds this address to the account of ${input.requester}.` : '';

  const text = [title, askedBy, `${action}: ${input.link}`, codeLine, expiry]
    .filter(Boolean)
    .join('\n\n');

  // The code is a letter-spaced chip, not a field: easy to read, nothing to type into.
  const chip = input.code
    ? `<p class="e-muted" style="margin:0 0 8px;${type('sm')};color:${c.muted}">Or enter this code</p>
<p style="margin:0 0 24px"><span class="e-chip e-strong" style="display:inline-block;padding:10px 16px;border-radius:${RADIUS.md}px;background:${c.sunken};font-family:${MONO};font-size:24px;line-height:28px;font-weight:600;letter-spacing:6px;color:${c.strong}">${escapeHtml(input.code)}</span></p>`
    : '';
  const body = `${titleHtml(title, `0 0 ${askedBy ? '8' : '24'}px`)}
${askedBy ? `<p class="e-text" style="margin:0 0 24px;${type('sm')};color:${c.text}">${escapeHtml(askedBy)}</p>` : ''}
<p style="margin:0 0 24px">${buttonHtml(input.link, action, true)}</p>
${chip}
<p class="e-muted" style="margin:0;${type('xs')};color:${c.muted}">${expiry}</p>`;

  const images = absolute(input.base);
  return {
    subject,
    html: emailShell({
      lang: 'en',
      title: subject,
      header: 'PassBook',
      ...(images
        ? {
            headerMark: `${input.base}/apple-touch-icon.png`,
            buddy: { base: input.base, mood: SIGN_IN_MOOD[input.purpose] },
          }
        : {}),
      body,
    }),
    text,
  };
}
