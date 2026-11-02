/** Script-free SSR pages for the auth flows, on the hosted shell shared with /login. */
import { type HostedArt, hostedPage } from '../../ssr/hosted.ts';
import { escapeHtml } from '../../ssr/theme.ts';

export { escapeHtml };

const ARROW =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';

const link = (href: string, label: string, outline = false) =>
  `<a class="btn${outline ? ' outline' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

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
  const lede =
    verify && input.requester
      ? `Adds <b>${escapeHtml(input.email)}</b> to ${escapeHtml(input.requester)}.`
      : `As <b>${escapeHtml(input.email)}</b>`;
  return hostedPage({
    nonce,
    title: verify ? 'Confirm email' : 'Sign in',
    art: 'confirm',
    lede,
    footer: !verify,
    body: `<form method="post" action="/auth/magic/consume"><input type="hidden" name="token" value="${escapeHtml(input.token)}"><button class="btn" type="submit">${verify ? 'Confirm' : `Sign in${ARROW}`}</button></form>`,
  });
}

/** Link or code no longer valid: one card greys and droops. */
export function expiredPage(nonce: string): string {
  return hostedPage({
    nonce,
    title: 'Link expired',
    art: 'expired',
    lede: 'Request a new one to sign in.',
    footer: true,
    body: link('/login', 'Back to sign in'),
  });
}

/** Polaris ID worked but the account may not use PassBook: the fan closes under a padlock. */
export function noAccessPage(nonce: string): string {
  return hostedPage({
    nonce,
    title: 'No access',
    art: 'no-access',
    lede: 'This Polaris ID account cannot use PassBook.',
    footer: true,
    body: `<div class="stack">${link('/login?focus=email', 'Sign in with email instead')}${link('/auth/oidc/start?prompt=login', 'Use another Polaris ID', true)}</div>`,
  });
}

export function messagePage(
  nonce: string,
  input: { title: string; message: string; href?: string; action?: string; art?: HostedArt },
): string {
  return hostedPage({
    nonce,
    title: input.title,
    art: input.art ?? 'expired',
    lede: escapeHtml(input.message),
    footer: true,
    body: input.href ? link(input.href, input.action ?? 'Continue') : '',
  });
}

export const SIGN_IN_ERRORS: Record<
  string,
  { title: string; message: string; status: 400 | 403; art?: HostedArt }
> = {
  NO_ACCESS: {
    title: 'No access',
    message: 'This Polaris ID account cannot use PassBook.',
    status: 403,
    art: 'no-access',
  },
  ACCOUNT_DISABLED: {
    title: 'Account disabled',
    message: 'This account is disabled. Ask an admin.',
    status: 403,
    art: 'no-access',
  },
  NO_EMAIL: {
    title: 'No email',
    message: 'The account has no email address. Add one in Polaris ID.',
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

/** Admin break-glass: a key on the clasp turns. */
export function breakglassPage(nonce: string, input: { error?: string; next?: string }): string {
  const next = input.next
    ? `<input type="hidden" name="next" value="${escapeHtml(input.next)}">`
    : '';
  return hostedPage({
    nonce,
    title: 'Break-glass sign-in',
    art: 'break-glass',
    ...(input.error ? { error: input.error } : {}),
    body: `<form class="stack" method="post" action="/auth/breakglass"><div><label for="t">Token</label><input id="t" name="token" type="password" autocomplete="off" required${input.error ? ' aria-invalid="true"' : ''}></div>${next}<button class="btn" type="submit">Sign in</button></form>`,
  });
}
