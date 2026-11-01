import { EMAIL_LIGHT as c, emailShell, escapeHtml } from './shell.ts';

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

export function renderSignInEmail(input: SignInEmailInput): RenderedEmail {
  const verify = input.purpose === 'verify_email';
  const subject = verify ? 'Confirm your email' : 'Your sign-in link';
  const title = verify ? 'Confirm your email' : 'Sign in to Wallet';
  const action = verify ? 'Confirm email' : 'Sign in';
  const expiry = `Expires in ${input.expiresMinutes} minutes. Ignore this email if you did not ask for it.`;
  const codeLine = input.code ? `Code: ${input.code}` : '';
  const askedBy =
    verify && input.requester ? `Adds this address to the account of ${input.requester}.` : '';

  const text = [askedBy, `${action}: ${input.link}`, codeLine, expiry].filter(Boolean).join('\n\n');

  const body = `<p class="e-strong" style="margin:0 0 ${askedBy ? '8' : '20'}px;font-size:20px;line-height:28px;font-weight:600;color:${c.strong}">${title}</p>
${askedBy ? `<p class="e-text" style="margin:0 0 20px;font-size:14px;line-height:20px;color:${c.text}">${escapeHtml(askedBy)}</p>` : ''}
<p style="margin:0 0 20px"><a class="e-btn" href="${escapeHtml(input.link)}" style="display:inline-block;background:${c.accent};color:${c.accentOn};text-decoration:none;font-size:15px;font-weight:500;line-height:20px;padding:8px 20px;border-radius:6px">${action}</a></p>
${input.code ? `<p class="e-muted" style="margin:0 0 4px;font-size:12px;line-height:18px;color:${c.muted}">Or enter this code</p><p class="e-well e-strong" style="margin:0 0 24px;padding:10px 12px;border:1px solid ${c.line};border-radius:6px;background:${c.page};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:20px;line-height:28px;letter-spacing:4px;color:${c.strong}">${escapeHtml(input.code)}</p>` : ''}
<p class="e-muted" style="margin:0;font-size:12px;line-height:18px;color:${c.muted}">${expiry}</p>`;

  return {
    subject,
    html: emailShell({
      lang: 'en',
      title: subject,
      header: 'Wallet',
      headerColor: '#1f2937',
      body,
    }),
    text,
  };
}
