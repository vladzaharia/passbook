/** Script-free SSR pages for the auth flows, on the hosted shell shared with /login. */

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ArrowRight } from 'lucide-react';
import {
  AUTH_PAGE_COPY as COPY,
  EXPIRED_LINK_COPY,
  OIDC_FAILURE_COPY,
  type OidcFailure,
  SIGN_IN_ERROR_COPY,
  type SignInErrorCode,
} from '../../../shared/copy/sign-in.ts';
import { STATE_COPY } from '../../../shared/copy/states.ts';
import { backToSignIn } from '../../ssr/error-page.tsx';
import type { PageTheme } from '../../ssr/head.ts';
import {
  actionHtml,
  type HostedArt,
  hostedPage,
  type PageAction,
  postButton,
} from '../../ssr/hosted.ts';
import { iconHtml } from '../../ssr/icon.ts';
import { escapeHtml } from '../../ssr/theme.ts';
import type { LinkTrace } from './magic-service.ts';
import { loginPath, safeNext } from './next.ts';

const ARROW = iconHtml(ArrowRight);

/** The confirm link itself, as a path sign-in can return to. */
export const confirmPath = (token: string) => `/auth/magic?t=${encodeURIComponent(token)}`;

/** A signed-out browser on an add-email link: sign in, then come back to Confirm. */
export const signInToConfirm = (token: string): PageAction => ({
  label: COPY.signInToConfirm,
  href: loginPath(confirmPath(token)),
  primary: true,
});

/** Sign-in link: one button posts the token. */
export function confirmPage(
  nonce: string,
  input: { token: string; email: string },
  theme?: PageTheme,
): string {
  return hostedPage({
    nonce,
    theme,
    title: COPY.signIn,
    art: 'confirm',
    lede: `As <b>${escapeHtml(input.email)}</b>`,
    footer: true,
    body: postButton('/auth/magic/consume', `${COPY.signIn}${ARROW}`, { token: input.token }),
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
      ? postButton('/auth/magic/consume', COPY.confirm, { token: input.token })
      : input.viewer === 'signed-out'
        ? actionHtml(signInToConfirm(input.token))
        : postButton(`/auth/logout?next=${encodeURIComponent(back)}`, STATE_COPY.switchAccount);
  return hostedPage({
    nonce,
    theme,
    title: COPY.confirmEmail,
    art: input.viewer === 'requester' ? 'confirm' : 'login',
    lede: input.viewer === 'other' ? `${adds} ${COPY.otherAccount}` : adds,
    body,
  });
}

/**
 * A dead link: the gold pass droops. A sign-in link leads back to sign-in (keeping its next); an
 * add-email link leads to Account, where the address is added again.
 */
export function expiredPage(
  nonce: string,
  link: LinkTrace | null = null,
  theme?: PageTheme,
): string {
  const verify = link?.purpose === 'verify_email';
  const copy = EXPIRED_LINK_COPY[verify ? 'verify_email' : 'sign_in'];
  return hostedPage({
    nonce,
    theme,
    title: copy.title,
    art: 'expired',
    lede: escapeHtml(copy.message),
    footer: !verify,
    body: actionHtml(
      verify ? { label: copy.action, href: '/account' } : backToSignIn(loginPath(link?.next)),
    ),
  });
}

/** Polaris ID worked but the account may not use PassBook: the buddy tugs at the padlock. */
export function noAccessPage(nonce: string, next: string | null = null, theme?: PageTheme): string {
  const keep = safeNext(next) ? `&next=${encodeURIComponent(safeNext(next) ?? '')}` : '';
  const copy = SIGN_IN_ERROR_COPY.NO_ACCESS;
  return hostedPage({
    nonce,
    theme,
    title: copy.title,
    art: 'no-access',
    lede: escapeHtml(copy.message),
    footer: true,
    body: `<div class="stack">${actionHtml({ label: COPY.emailInstead, href: loginPath(next, 'focus=email'), primary: true })}${actionHtml({ label: COPY.otherPolarisId, href: `/auth/oidc/start?prompt=login${keep}` })}</div>`,
  });
}

function messagePage(
  nonce: string,
  input: { title: string; message: string; action: PageAction; art: HostedArt },
  theme?: PageTheme,
): string {
  return hostedPage({
    nonce,
    theme,
    title: input.title,
    art: input.art,
    lede: escapeHtml(input.message),
    footer: true,
    body: actionHtml(input.action),
  });
}

/**
 * Each refusal's status and meaning (the buddy spec): sad, with forbidden's padlock, an error's plug, expired's drooping pass or a rate limit's hourglass.
 * What waits on you (a missing email, a sent proof, signing in first) is the waiting scene.
 */
const PAGE: Record<SignInErrorCode, { status: ContentfulStatusCode; art: HostedArt }> = {
  NO_ACCESS: { status: 403, art: 'no-access' },
  ACCOUNT_DISABLED: { status: 403, art: 'no-access' },
  NO_EMAIL: { status: 403, art: 'no-access' },
  EMAIL_UNVERIFIED: { status: 403, art: 'no-access' },
  EMAIL_CONFLICT: { status: 403, art: 'no-access' },
  EMAIL_PROOF_SENT: { status: 403, art: 'login' },
  SESSION_REQUIRED: { status: 403, art: 'no-access' },
  LINK_INVALID: { status: 400, art: 'expired' },
  EMAIL_TAKEN: { status: 403, art: 'no-access' },
  MAGIC_LINK_DISABLED: { status: 503, art: 'broken' },
  RATE_LIMITED: { status: 429, art: 'throttled' },
  VALIDATION: { status: 422, art: 'broken' },
};

/** The page for a refused sign-in: the shared copy, a status and a way back that keeps next. */
export function signInErrorPage(
  nonce: string,
  code: SignInErrorCode,
  opts: { next?: string | null; action?: PageAction } = {},
  theme?: PageTheme,
): { html: string; status: ContentfulStatusCode } {
  // One page for "no access", whichever route refuses.
  if (code === 'NO_ACCESS')
    return { html: noAccessPage(nonce, opts.next ?? null, theme), status: 403 };
  const { status, art } = PAGE[code];
  const action = opts.action ?? backToSignIn(loginPath(opts.next));
  return { html: messagePage(nonce, { ...SIGN_IN_ERROR_COPY[code], action, art }, theme), status };
}

const OIDC_ART: Record<OidcFailure, HostedArt> = {
  cancelled: 'login',
  expired: 'expired',
  unverified: 'broken',
  unavailable: 'broken',
};

/** A Polaris ID round trip that did not finish: one line and a way back that keeps next. */
export function oidcFailurePage(
  nonce: string,
  failure: OidcFailure,
  next: string | null,
  theme?: PageTheme,
): string {
  const action = backToSignIn(loginPath(next));
  return messagePage(
    nonce,
    { ...OIDC_FAILURE_COPY[failure], action, art: OIDC_ART[failure] },
    theme,
  );
}

/**
 * Leaving for Pocket ID's end-session after a form post: the CSP's form-action 'self' blocks a
 * redirect off-site, so this page moves on by itself (Continue, if refresh is off).
 */
export function leavingPage(nonce: string, href: string, theme?: PageTheme): string {
  return hostedPage({
    nonce,
    theme,
    title: COPY.signingOut,
    art: 'login',
    refresh: href,
    body: actionHtml({ label: COPY.continue, href, primary: true }),
  });
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
    title: COPY.breakglass,
    art: 'break-glass',
    ...(input.error ? { error: input.error } : {}),
    body: `<form class="stack" method="post" action="/auth/breakglass"><div><label for="t">${COPY.token}</label><input id="t" name="token" type="password" autocomplete="off" required${input.error ? ' aria-invalid="true"' : ''}></div>${next}<button class="btn" type="submit">${COPY.signIn}</button></form>`,
  });
}
