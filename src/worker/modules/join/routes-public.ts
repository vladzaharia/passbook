import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { JOIN_FORM_MAX_BYTES } from '../../../shared/contracts/join.ts';
import {
  PublicAssetParamSchema,
  PublicTokenParamSchema,
} from '../../../shared/contracts/public.ts';
import { passDevice } from '../../../shared/device.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import {
  ASSET_MISSES_PER_MINUTE,
  checkRateLimit,
  clientIp,
  clientRatePrefix,
  gateMisses,
  rateLimit,
} from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requestTheme } from '../../ssr/head.ts';
import { type JoinPage, renderJoinPage, statusOf } from '../../ssr/join-page.tsx';
import { orgBrandOf } from '../orgs/brand.ts';
import { type C, svc } from '../passes/http.ts';
import { holderZone } from '../public/holder-zone.ts';
import { langOf, PAGE_HEADERS } from '../public/routes.ts';
import { platformLimits } from './caps.ts';
import { readDeviceCookie, setDeviceCookie } from './cookie.ts';
import { type OpenRelease, openRelease } from './issue.ts';
import type { JoinOutcome } from './outcome.ts';
import { joinPreview, previewImage } from './preview.ts';
import type { PublicLink } from './repo-issues.ts';
import { closedReason, submitJoin } from './submit.ts';
import { lookupLink, refuse } from './submit-after.ts';

/** /j: a public join link's page and form. No sign-in; every write is the link's own grant. */
export const joinPublicRoutes = createRouter();
// An unknown or rotated token is a 404 the prefix is charged for, before any lookup runs again.
joinPublicRoutes.use('/:token', gateMisses(ASSET_MISSES_PER_MINUTE));
joinPublicRoutes.use('/:token', limitBody(JOIN_FORM_MAX_BYTES));
joinPublicRoutes.on('GET', '/:token', rateLimit('RL_PUBLIC'));
// The card's images: a page loads a few per view.
joinPublicRoutes.use('/:token/card/*', gateMisses(ASSET_MISSES_PER_MINUTE));
joinPublicRoutes.use('/:token/card/*', rateLimit('RL_PUBLIC_ASSET'));

const html = (c: C, page: JoinPage, status?: ContentfulStatusCode) =>
  c.html(
    renderJoinPage(page, c.var.nonce, requestTheme(c)),
    status ?? statusOf(page),
    PAGE_HEADERS,
  );

/** The open release of a link, or null when it cannot take cards (a refusal the caller already knows how to say). */
async function openOf(ctx: ServiceContext, link: PublicLink): Promise<OpenRelease | null> {
  try {
    return await openRelease(ctx, link);
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    return null;
  }
}

/** The form page; the card is the open release's with defaults only. A card that will not draw leaves the form working. */
async function formPage(
  c: C,
  link: PublicLink,
  open: OpenRelease | null,
  extra: Partial<Extract<JoinPage, { kind: 'form' }>> = {},
): Promise<JoinPage> {
  const ctx = svc(c);
  let card: Awaited<ReturnType<typeof joinPreview>> | null = null;
  if (open) {
    try {
      card = await joinPreview(ctx, link, open, c.req.param('token') ?? '', {
        locale: langOf(c.req.header('accept-language')),
        timeZone: await holderZone(ctx, link.orgId),
      });
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        ctx.log.warn('join.preview_failed', {
          code: error.code,
          linkId: link.id,
          orgId: link.orgId,
        });
      } else throw error;
    }
  }
  return {
    kind: 'form',
    orgName: link.orgName,
    brand: await orgBrandOf(ctx, link.orgId),
    askName: open ? open.readiness.nameInput !== null : link.nameInput !== null,
    askEmail: link.askEmail,
    test: link.mode === 'test',
    card,
    siteKey: c.env.TURNSTILE_SITE_KEY,
    device: passDevice(c.req.header('user-agent')),
    ...extra,
  };
}

async function respond(c: C, outcome: JoinOutcome) {
  switch (outcome.kind) {
    case 'card':
      setDeviceCookie(c, outcome.device);
      c.header('cache-control', PAGE_HEADERS['cache-control']);
      // A 303: the browser follows with a GET, so the form post is never repeated.
      return c.redirect(`/p/${outcome.token}`, 303);
    case 'check_email':
      return html(c, {
        kind: 'check_email',
        orgName: outcome.link.orgName,
        email: outcome.email,
        brand: await orgBrandOf(svc(c), outcome.link.orgId),
      });
    case 'form':
      return html(
        c,
        await formPage(c, outcome.link, await openOf(svc(c), outcome.link), {
          askName: outcome.askName,
          values: outcome.values,
          error: outcome.error,
        }),
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
    const open = await openOf(ctx, link);
    if (!open) {
      refuse(ctx, link, 'JOIN_NOT_READY', 'error');
      return html(c, { kind: 'refused', reason: 'closed' });
    }
    return html(c, await formPage(c, link, open));
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

const IMAGE_HEADERS = {
  'content-type': 'image/png',
  'cache-control': 'private, max-age=300',
  'x-content-type-options': 'nosniff',
};

register(
  joinPublicRoutes,
  'join',
  {
    method: 'get',
    path: '/{token}/card/{name}',
    summary: 'Join page card image',
    params: PublicAssetParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const p = c.req.valid('param');
    const link = await lookupLink(ctx, p.token);
    const open =
      link && !closedReason(link, await platformLimits(ctx, link.mode))
        ? await openOf(ctx, link)
        : null;
    if (!link || !open) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
    const image = await previewImage(ctx, link, open, p.name);
    const headers = { ...IMAGE_HEADERS, etag: image.etag };
    if (c.req.header('if-none-match') === image.etag) {
      await image.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    return new Response(image.body, { headers });
  },
);
