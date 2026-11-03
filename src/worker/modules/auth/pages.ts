/** Script-free SSR pages for the auth flows, on the hosted shell shared with /login. */

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ArrowRight } from 'lucide-react';
import { SIGN_IN_ERROR_COPY, type SignInErrorCode } from '../../../shared/copy/sign-in.ts';
import type { PageTheme } from '../../ssr/head.ts';
import { type HostedArt, hostedPage } from '../../ssr/hosted.ts';
import { iconHtml } from '../../ssr/icon.ts';
import { escapeHtml } from '../../ssr/theme.ts';
import { loginPath, safeNext } from './next.ts';

export { escapeHtml };

const ARROW = iconHtml(ArrowRight);

const link = (href: string, label: string, outline = false) =>
  `<a class="btn${outline ? ' outline' : ''}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

const postButton = (action: string, label: string, fields: Record<string, string> = {}) =>
  `<form method="post" action="${escapeHtml(action)}">${Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('')}<button class="btn" type="submit">${label}</button></form>`;

/** The confirm link itself, as a path sign-in can return to. */
export const confirmPath = (token: string) => `/auth/magic?t=${encodeURIComponent(token)}`;

/** Sign-in link: one button posts the token. An add-email link shows its requester's Confirm. */
export function confirmPage(
  nonce: string,
  input: {
    token: string;
    email: string;
    purpose?: 'sign_in' | 'verify_email';
    requester?: string | null;
  },
  theme?: PageTheme,
): string {
  if (input.purpose === 'verify_email') {
    const verify = { ...input, requester: input.requester ?? null, viewer: 'requester' } as const;
    return verifyPage(nonce, verify, theme);
  }
  return hostedPage({
    nonce,
    theme,
    title: 'Sign in',
    art: 'confirm',
    lede: `As <b>${escapeHtml(input.email)}</b>`,
    footer: true,
    body: postButton('/auth/magic/consume', `Sign in${ARROW}`, { token: input.token }),
  });
}

/**
 * Add-email link. Only the account that asked may confirm, so the page answers who is here:
 * that account gets Confirm; a signed-out browser signs in and comes back; another account
 * switches (signs out, keeping the link as next).
 */
export function verifyPage(
  nonce: string,
  input: {
    token: string;
    email: string;
    requester: string | null;
    viewer: 'requester' | 'signed-out' | 'other';
  },
  theme?: PageTheme,
): string {
  const back = confirmPath(input.token);
  const adds = `Adds <b>${escapeHtml(input.email)}</b>${input.requester ? ` to ${escapeHtml(input.requester)}` : ''}.`;
  const body =
    input.viewer === 'requester'
      ? postButton('/auth/magic/consume', 'Confirm', { token: input.token })
      : input.viewer === 'signed-out'
        ? link(loginPath(back), 'Sign in to confirm')
        : postButton(`/auth/logout?next=${encodeURIComponent(back)}`, 'Switch account');
  return hostedPage({
    nonce,
    theme,
    title: 'Confirm email',
    art: input.viewer === 'requester' ? 'confirm' : 'login',
    lede: input.viewer === 'other' ? `${adds} This browser is signed in to another account.` : adds,
    body,
  });
}

/** Link or code no longer valid: one card greys and droops. */
export function expiredPage(nonce: string, next: string | null = null, theme?: PageTheme): string {
  return hostedPage({
    nonce,
    theme,
    title: 'Link expired',
    art: 'expired',
    lede: 'Request a new one to sign in.',
    footer: true,
    body: link(loginPath(next), 'Back to sign in'),
  });
}

/** Polaris ID worked but the account may not use PassBook: the fan closes under a padlock. */
export function noAccessPage(nonce: string, next: string | null = null, theme?: PageTheme): string {
  const keep = safeNext(next) ? `&next=${encodeURIComponent(safeNext(next) ?? '')}` : '';
  return hostedPage({
    nonce,
    theme,
    title: 'No access',
    art: 'no-access',
    lede: escapeHtml(SIGN_IN_ERROR_COPY.NO_ACCESS.message),
    footer: true,
    body: `<div class="stack">${link(loginPath(next, 'focus=email'), 'Sign in with email instead')}${link(`/auth/oidc/start?prompt=login${keep}`, 'Use another Polaris ID', true)}</div>`,
  });
}

export function messagePage(
  nonce: string,
  input: { title: string; message: string; href?: string; action?: string; art?: HostedArt },
  theme?: PageTheme,
): string {
  return hostedPage({
    nonce,
    theme,
    title: input.title,
    art: input.art ?? 'expired',
    lede: escapeHtml(input.message),
    footer: true,
    body: input.href ? link(input.href, input.action ?? 'Continue') : '',
  });
}

const PAGE: Record<SignInErrorCode, { status: ContentfulStatusCode; art?: HostedArt }> = {
  NO_ACCESS: { status: 403, art: 'no-access' },
  ACCOUNT_DISABLED: { status: 403, art: 'no-access' },
  NO_EMAIL: { status: 403 },
  EMAIL_CONFLICT: { status: 403 },
  EMAIL_PROOF_SENT: { status: 403, art: 'login' },
  SESSION_REQUIRED: { status: 403 },
  LINK_INVALID: { status: 400 },
  EMAIL_TAKEN: { status: 403 },
  MAGIC_LINK_DISABLED: { status: 503, art: 'no-access' },
  RATE_LIMITED: { status: 429, art: 'throttled' },
  VALIDATION: { status: 422 },
};

/** A refused sign-in by code: the shared copy, its status and art. */
export const SIGN_IN_ERRORS: Record<
  string,
  { title: string; message: string; status: ContentfulStatusCode; art?: HostedArt }
> = Object.fromEntries(
  Object.entries(PAGE).map(([code, page]) => [
    code,
    { ...SIGN_IN_ERROR_COPY[code as SignInErrorCode], ...page },
  ]),
);

/** The page for a refused sign-in: the shared copy, a status and a way back that keeps next. */
export function signInErrorPage(
  nonce: string,
  code: SignInErrorCode,
  opts: { next?: string | null; href?: string; action?: string } = {},
  theme?: PageTheme,
): { html: string; status: ContentfulStatusCode } {
  const { status, art } = PAGE[code];
  const html = messagePage(
    nonce,
    {
      ...SIGN_IN_ERROR_COPY[code],
      href: opts.href ?? loginPath(opts.next),
      action: opts.action ?? 'Back to sign in',
      ...(art ? { art } : {}),
    },
    theme,
  );
  return { html, status };
}

/** Admin break-glass: a key on the clasp turns. */
export function breakglassPage(
  nonce: string,
  input: { error?: string; next?: string },
  theme?: PageTheme,
): string {
  const next = input.next
    ? `<input type="hidden" name="next" value="${escapeHtml(input.next)}">`
    : '';
  return hostedPage({
    nonce,
    theme,
    title: 'Break-glass sign-in',
    art: 'break-glass',
    ...(input.error ? { error: input.error } : {}),
    body: `<form class="stack" method="post" action="/auth/breakglass"><div><label for="t">Token</label><input id="t" name="token" type="password" autocomplete="off" required${input.error ? ' aria-invalid="true"' : ''}></div>${next}<button class="btn" type="submit">Sign in</button></form>`,
  });
}
