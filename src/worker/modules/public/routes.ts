import { PublicAssetParamSchema, PublicTokenParamSchema } from '../../../shared/contracts/index.ts';
import { passDevice } from '../../../shared/device.ts';
import { normalize } from '../../../shared/pass-view/index.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { requestTheme } from '../../ssr/head.ts';
import { renderNotFoundPage, renderPassPage } from '../../ssr/pass-page.tsx';
import { recordPassEvent } from '../events/record.ts';
import { servePassFile } from '../passes/file.ts';
import { type C, svc } from '../passes/http.ts';
import {
  isTokenShape,
  openPublicAsset,
  pageModel,
  passForToken,
  supportContacts,
} from './service.ts';

/** /p: bearer-link pass page and download. No sign-in. */
export const publicRoutes = createRouter();
// Mail proxies fetch every emailed pass's images from a few IPs, so assets are limited per
// token and IP prefix; a malformed token (no pass behind it) falls back to the IP alone.
publicRoutes.use(
  '/:token/assets/*',
  rateLimit('RL_PUBLIC_ASSET', (c) => {
    const ip = clientIp(c);
    const token = c.req.param('token') ?? '';
    return isTokenShape(token) ? `${token}:${ipPrefix(ip) ?? ip}` : `ip:${ip}`;
  }),
);
publicRoutes.use('/:token', rateLimit('RL_PUBLIC'));
publicRoutes.use('/:token/pass.pkpass', rateLimit('RL_PUBLIC'));

export const EMAILED = /^(icon|logo)(@[23]x)?\.png$/;

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
};

/** Formatting locale for dates and numbers on the card; the page copy stays English. */
export const langOf = (header: string | undefined): string => {
  const tag = header?.split(',')[0]?.split(';')[0]?.trim();
  return tag && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : 'en';
};

/** Visitor zone from Cloudflare, if it is a zone Intl knows. */
export function zoneOf(c: C): string | undefined {
  const tz = c.req.raw.cf?.timezone;
  if (typeof tz !== 'string' || !tz) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

register(
  publicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}',
    summary: 'Pass page (server-rendered HTML)',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const svcCtx = svc(c);
    const nonce = c.var.nonce;
    const theme = requestTheme(c);
    try {
      const pass = await passForToken(svcCtx, c.req.valid('param').token);
      const model = await pageModel(svcCtx, pass);
      const lang = langOf(c.req.header('accept-language'));
      const view = normalize(model.passJson, {
        assets: model.assets,
        locale: lang,
        now: new Date(svcCtx.clock.now()),
        timeZone: zoneOf(c) ?? 'UTC',
      });
      svcCtx.waitUntil(
        recordPassEvent(svcCtx, {
          orgId: pass.orgId,
          passId: pass.id,
          mode: pass.mode,
          kind: 'page.opened',
          actor: { type: 'holder', id: null },
        }),
      );
      const page = `/p/${pass.downloadToken}`;
      const html = renderPassPage({
        view,
        nonce,
        theme,
        orgName: view.organizationName || model.orgName,
        orgLabel: model.orgName,
        passTitle: pass.displayTitle ?? view.description ?? model.orgName,
        downloadHref: `${page}/pass.pkpass`,
        // The add QR opens this page on the phone, where the badge adds the pass.
        publicUrl: `${baseUrl(c.env)}${page}`,
        portalHref: `/passes/${pass.id}`,
        voided: pass.status === 'voided',
        removal: model.removal,
        mode: pass.mode,
        device: passDevice(c.req.header('user-agent')),
        support: await supportContacts(svcCtx, pass.orgId),
      });
      return new Response(html, { headers: PAGE_HEADERS });
    } catch (error) {
      if (error instanceof AppError && error.status === 404)
        return new Response(renderNotFoundPage(nonce, theme), {
          status: 404,
          headers: PAGE_HEADERS,
        });
      throw error;
    }
  },
);

register(
  publicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/pass.pkpass',
    summary: 'Download the pass',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const pass = await passForToken(svc(c), c.req.valid('param').token);
    const response = await servePassFile(c.env.BUCKET, pass, c.req.raw);
    if (response.status === 200) {
      writeEvent(c.env, {
        event: 'pass.downloaded',
        orgId: pass.orgId,
        templateId: pass.templateId,
        identityId: pass.identityId,
        mode: pass.mode,
      });
      await recordPassEvent(svc(c), {
        orgId: pass.orgId,
        passId: pass.id,
        mode: pass.mode,
        kind: 'pass.downloaded',
        actor: { type: 'holder', id: null },
      });
    }
    return response;
  },
);

register(
  publicRoutes,
  'public',
  {
    method: 'get',
    path: '/{token}/assets/{name}',
    summary: 'Pass image',
    params: PublicAssetParamSchema,
  },
  async (c) => {
    const p = c.req.valid('param');
    const ctx = svc(c);
    const pass = await passForToken(ctx, p.token);
    const asset = await openPublicAsset(ctx, pass, p.name);
    const headers = {
      'content-type': 'image/png',
      etag: asset.etag,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      // The pass email shows the icon and logo, and webmail loads them from its own origin.
      ...(EMAILED.test(p.name) ? { 'cross-origin-resource-policy': 'cross-origin' } : {}),
    };
    if (c.req.header('if-none-match') === asset.etag) {
      await asset.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    return new Response(asset.body, { headers });
  },
);
