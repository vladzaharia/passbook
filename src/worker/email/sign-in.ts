export interface SignInEmailInput {
  purpose: 'sign_in' | 'verify_email';
  link: string;
  /** Present for sign_in only. */
  code?: string;
  expiresMinutes: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function renderSignInEmail(input: SignInEmailInput): RenderedEmail {
  const verify = input.purpose === 'verify_email';
  const subject = verify ? 'Confirm your email' : 'Your sign-in link';
  const action = verify ? 'Confirm email' : 'Sign in';
  const expiry = `Expires in ${input.expiresMinutes} minutes. Ignore this email if you did not ask for it.`;
  const codeLine = input.code ? `Code: ${input.code}` : '';

  const text = [`${action}: ${input.link}`, codeLine, expiry].filter(Boolean).join('\n\n');

  const link = escapeHtml(input.link);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;background:#fff;border-radius:8px;padding:24px">
<tr><td style="font-size:16px;line-height:24px">
<p style="margin:0 0 16px"><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">${action}</a></p>
${input.code ? `<p style="margin:0 0 16px">Code: <strong style="font-size:20px;letter-spacing:3px">${escapeHtml(input.code)}</strong></p>` : ''}
<p style="margin:0;font-size:13px;line-height:20px;color:#555">${expiry}</p>
</td></tr></table></td></tr></table></body></html>`;

  return { subject, html, text };
}
