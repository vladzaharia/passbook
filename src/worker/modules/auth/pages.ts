/** Script-free SSR pages for the auth flows. */
import {
  SSR_CARD_CSS,
  THEME_CSS,
  themeInitHtml,
  themeToggleHtml,
  wordmarkHtml,
} from '../../ssr/theme.ts';

export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const STYLE = `${THEME_CSS}
main{width:100%;max-width:24rem;margin:0 auto;padding:2.5rem 1rem}
h1{margin:0 0 1rem;font-size:1.5rem;line-height:2rem;font-weight:600;color:var(--strong)}
.card{border:1px solid var(--line);border-radius:.5rem;background:var(--raised);padding:1rem;box-shadow:0 1px 2px rgb(0 0 0/.12)}
.card p{margin:0 0 1rem;color:var(--muted)}
.card p:last-child,.card form p:last-child{margin-bottom:0}
.btn,button{display:inline-flex;align-items:center;justify-content:center;width:100%;height:2.25rem;padding:0 1rem;border:0;border-radius:.375rem;background:var(--accent);color:var(--accent-on);font:inherit;font-weight:500;text-decoration:none;cursor:pointer}
.btn:hover,button:hover{filter:brightness(1.08)}
label{display:block;margin:0 0 .25rem;font-weight:500;color:var(--strong)}
input{width:100%;height:2.25rem;padding:0 .75rem;border:1px solid var(--line-strong);border-radius:.375rem;background:var(--sunken);color:var(--fg);font:inherit}
.field{margin:0 0 1rem}
.err{border:1px solid var(--danger);border-radius:.375rem;background:var(--danger-subtle);color:var(--strong)!important;padding:.5rem .75rem}
.who{font-weight:500;color:var(--strong)!important;overflow-wrap:anywhere}
${SSR_CARD_CSS}`;

function layout(nonce: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLE}</style>${themeInitHtml}</head><body><header class="top">${wordmarkHtml()}${themeToggleHtml}</header><main><h1>${escapeHtml(title)}</h1><div class="card">${body}</div></main></body></html>`;
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
    `<p class="who">${escapeHtml(input.email)}</p>${verify && input.requester ? `<p>Adds this address to the account of ${escapeHtml(input.requester)}.</p>` : ''}
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
  return layout(nonce, input.title, `<p>${escapeHtml(input.message)}</p>${link}`);
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

export function breakglassPage(nonce: string, input: { error?: string; next?: string }): string {
  const error = input.error ? `<p class="err" role="alert">${escapeHtml(input.error)}</p>` : '';
  const next = input.next
    ? `<input type="hidden" name="next" value="${escapeHtml(input.next)}">`
    : '';
  return layout(
    nonce,
    'Break-glass sign-in',
    `${error}
<form method="post" action="/auth/breakglass"><div class="field"><label for="t">Token</label>
<input id="t" name="token" type="password" autocomplete="off" required></div>${next}
<button type="submit">Sign in</button></form>`,
  );
}
