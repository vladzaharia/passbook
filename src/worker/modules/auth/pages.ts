/** Script-free SSR pages for the auth flows. */

export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--line:#ddd}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#999;--line:#333}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{width:100%;max-width:360px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:var(--mut)}
button,a.btn{display:inline-block;font:inherit;padding:10px 18px;border-radius:6px;border:1px solid var(--fg);background:var(--fg);color:var(--bg);cursor:pointer;text-decoration:none}
a{color:var(--fg)}`;

function layout(nonce: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function confirmPage(
  nonce: string,
  input: {
    token: string;
    email: string;
    purpose: 'sign_in' | 'verify_email';
    requester?: string | null;
  },
): string {
  const verify = input.purpose === 'verify_email';
  return layout(
    nonce,
    verify ? 'Confirm email' : 'Sign in',
    `<h1>${verify ? 'Confirm email' : 'Sign in'}</h1>
<p>${escapeHtml(input.email)}</p>${verify && input.requester ? `<p>Adds this address to the account of ${escapeHtml(input.requester)}.</p>` : ''}
<form method="post" action="/auth/magic/consume"><input type="hidden" name="token" value="${escapeHtml(input.token)}"><button type="submit">${verify ? 'Confirm' : 'Sign in'}</button></form>`,
  );
}

export function messagePage(
  nonce: string,
  input: { title: string; message: string; href?: string; action?: string },
): string {
  const link = input.href
    ? `<a class="btn" href="${escapeHtml(input.href)}">${escapeHtml(input.action ?? 'Continue')}</a>`
    : '';
  return layout(
    nonce,
    input.title,
    `<h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${link}`,
  );
}

export const SIGN_IN_ERRORS: Record<string, { title: string; message: string; status: 400 | 403 }> =
  {
    NO_ACCESS: {
      title: 'No access',
      message: 'This account is not in an allowed group. Ask an admin.',
      status: 403,
    },
    ACCOUNT_DISABLED: {
      title: 'Account disabled',
      message: 'This account is disabled. Ask an admin.',
      status: 403,
    },
    NO_EMAIL: {
      title: 'No email',
      message: 'The account has no email address. Add one in Pocket ID.',
      status: 403,
    },
    EMAIL_CONFLICT: {
      title: 'Email in use',
      message: 'This email belongs to another account. Sign in with an email link first.',
      status: 403,
    },
    EMAIL_PROOF_SENT: {
      title: 'Check your email',
      message: 'This email belongs to an existing account. Open the link we sent, in this browser.',
      status: 403,
    },
    SESSION_REQUIRED: {
      title: 'Sign in first',
      message: 'Open this link in the browser signed in to the account that asked for it.',
      status: 403,
    },
    LINK_INVALID: {
      title: 'Link expired',
      message: 'This link or code is invalid or expired. Request a new one.',
      status: 400,
    },
    EMAIL_TAKEN: {
      title: 'Email in use',
      message: 'That address belongs to another account.',
      status: 403,
    },
  };
