import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { JOIN_FORM_MAX_BYTES } from '../../../shared/contracts/join.ts';
import { PublicTokenParamSchema } from '../../../shared/contracts/public.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, ForbiddenError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import {
  ASSET_MISSES_PER_MINUTE,
  checkRateLimit,
  clientIp,
  clientRatePrefix,
  gateMisses,
  rateLimit,
} from '../../platform/rate-limit.ts';
import { requestTheme } from '../../ssr/head.ts';
import { type C, svc } from '../passes/http.ts';
import { PAGE_HEADERS } from '../public/routes.ts';
import { platformLimits } from './caps.ts';
import { readDeviceCookie, setDeviceCookie } from './cookie.ts';
import { openRelease } from './issue.ts';
import type { PublicLink } from './repo-issues.ts';
import { type JoinPage, renderJoinPage, statusOf } from './stub-page.ts';
import { closedReason, type JoinOutcome, lookupLink, refuse, submitJoin } from './submit.ts';

/** /j: a public join link's page and form. No sign-in; every write is the link's own grant. */
export const joinPublicRoutes = createRouter();
// An unknown or rotated token is a 404 the prefix is charged for, before any lookup runs again.
joinPublicRoutes.use('/:token', gateMisses(ASSET_MISSES_PER_MINUTE));
joinPublicRoutes.use('/:token', limitBody(JOIN_FORM_MAX_BYTES));
joinPublicRoutes.on('GET', '/:token', rateLimit('RL_PUBLIC'));

const html = (c: C, page: JoinPage, status?: ContentfulStatusCode) =>
  c.html(
    renderJoinPage(page, c.var.nonce, requestTheme(c)),
    status ?? statusOf(page),
    PAGE_HEADERS,
  );

const formPage = (
  link: PublicLink,
  askName: boolean,
  extra: Partial<Extract<JoinPage, { kind: 'form' }>> = {},
): JoinPage => ({
  kind: 'form',
  orgName: link.orgName,
  askName,
  askEmail: link.askEmail,
  test: link.mode === 'test',
  ...extra,
});

function respond(c: C, outcome: JoinOutcome) {
  switch (outcome.kind) {
    case 'card':
      setDeviceCookie(c, outcome.device);
      c.header('cache-control', PAGE_HEADERS['cache-control']);
      // A 303: the browser follows with a GET, so the form post is never repeated.
      return c.redirect(`/p/${outcome.token}`, 303);
    case 'check_email':
      return html(c, { kind: 'check_email', orgName: outcome.link.orgName, email: outcome.email });
    case 'form':
      return html(
        c,
        formPage(outcome.link, outcome.askName, { values: outcome.values, error: outcome.error }),
        outcome.status ?? 422,
      );
    case 'refused':
      return html(c, { kind: 'refused', reason: outcome.reason });
  }
}

register(
  joinPublicRoutes,
  'join',
  {
    method: 'get',
    path: '/{token}',
    summary: 'Join page (server-rendered HTML)',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const link = await lookupLink(ctx, c.req.valid('param').token);
    if (!link) return html(c, { kind: 'refused', reason: 'expired' });
    if (closedReason(link, await platformLimits(ctx, link.mode))) {
      refuse(ctx, link, 'JOIN_LINK_CLOSED');
      return html(c, { kind: 'refused', reason: 'closed' });
    }
    let open: Awaited<ReturnType<typeof openRelease>> = null;
    try {
      open = await openRelease(ctx, link);
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
    }
    if (!open) {
      refuse(ctx, link, 'JOIN_NOT_READY', 'error');
      return html(c, { kind: 'refused', reason: 'closed' });
    }
    return html(c, formPage(link, open.readiness.nameInput !== null));
  },
);

register(
  joinPublicRoutes,
  'join',
  {
    method: 'post',
    path: '/{token}',
    summary: 'Join form post: makes a card, or answers why not',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    // 1. Requests per network.
    if (!(await checkRateLimit(c.env, 'RL_JOIN', `join:${clientRatePrefix(c)}`))) {
      refuse(ctx, null, 'JOIN_IP_LIMIT');
      return html(c, { kind: 'refused', reason: 'too_many' });
    }
    if (
      !(c.req.header('content-type') ?? '')
        .toLowerCase()
        .startsWith('application/x-www-form-urlencoded')
    )
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415, 'Send the form as a plain form post.');
    // 2. A post from another site is refused; an absent Origin is allowed (Turnstile still applies).
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== new URL(baseUrl(c.env)).origin)
      throw new ForbiddenError('Reload the page and try again.', 'JOIN_ORIGIN');
    const outcome = await submitJoin(ctx, {
      token: c.req.valid('param').token,
      fields: new URLSearchParams(await c.req.text()),
      ip: clientIp(c),
      prefix: clientRatePrefix(c),
      device: readDeviceCookie(c),
    });
    return respond(c, outcome);
  },
);
