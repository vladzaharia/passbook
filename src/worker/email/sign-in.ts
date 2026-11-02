import { buttonHtml, EMAIL_LIGHT as c, emailShell, escapeHtml, MONO } from './shell.ts';

export interface SignInEmailInput {
  purpose: 'sign_in' | 'verify_email';
  link: string;
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

/** The PassBook mark for the header: the app icon PNG next to the link's origin. */
function markUrl(link: string): string | undefined {
  try {
    return `${new URL(link).origin}/apple-touch-icon.png`;
  } catch {
    // A relative or malformed link: the header shows the word alone.
    return undefined;
  }
}

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
    ? `<p class="e-muted" style="margin:0 0 8px;font-size:14px;line-height:20px;color:${c.muted}">Or enter this code</p>
<p style="margin:0 0 24px"><span class="e-chip e-strong" style="display:inline-block;padding:10px 16px;border-radius:8px;background:${c.sunken};font-family:${MONO};font-size:24px;line-height:28px;font-weight:600;letter-spacing:6px;color:${c.strong}">${escapeHtml(input.code)}</span></p>`
    : '';
  const body = `<p class="e-strong" style="margin:0 0 ${askedBy ? '8' : '20'}px;font-size:20px;line-height:28px;font-weight:600;color:${c.strong}">${title}</p>
${askedBy ? `<p class="e-text" style="margin:0 0 20px;font-size:14px;line-height:20px;color:${c.text}">${escapeHtml(askedBy)}</p>` : ''}
<p style="margin:0 0 24px">${buttonHtml(input.link, action, true)}</p>
${chip}
<p class="e-muted" style="margin:0;font-size:12px;line-height:18px;color:${c.muted}">${expiry}</p>`;

  const mark = markUrl(input.link);
  return {
    subject,
    html: emailShell({
      lang: 'en',
      title: subject,
      header: 'PassBook',
      headerColor: '#060912',
      ...(mark ? { headerMark: mark } : {}),
      body,
    }),
    text,
  };
}
