import { PublicAssetParamSchema, PublicTokenParamSchema } from '../../../shared/contracts/index.ts';
import { normalize } from '../../../shared/pass-view/index.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { passDevice } from '../../ssr/device.ts';
import { renderNotFoundPage, renderPassPage } from '../../ssr/pass-page.tsx';
import { qrDataUri } from '../../ssr/qr.ts';
import { servePassFile } from '../passes/file.ts';
import { type C, svc } from '../passes/http.ts';
import { openPublicAsset, pageModel, passForToken, supportContacts } from './service.ts';

/** /p: bearer-link pass page and download. No sign-in. */
export const publicRoutes = createRouter();
publicRoutes.use('*', rateLimit('RL_PUBLIC'));

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
};

/** Formatting locale for dates and numbers on the card; the page copy stays English. */
const langOf = (header: string | undefined): string => {
  const tag = header?.split(',')[0]?.split(';')[0]?.trim();
  return tag && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : 'en';
};

/** Visitor zone from Cloudflare, if it is a zone Intl knows. */
function zoneOf(c: C): string | undefined {
  const tz = c.req.raw.cf?.timezone;
  if (typeof tz !== 'string' || !tz) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

type Token = { token: string };

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
      const base = baseUrl(c.env);
      const downloadHref = `/p/${pass.downloadToken}/pass.pkpass`;
      const html = renderPassPage({
        view,
        nonce,
        orgName: view.organizationName || model.orgName,
        passTitle: pass.displayTitle ?? view.description ?? model.orgName,
        downloadHref,
        qrSrc: pass.status === 'active' ? qrDataUri(`${base}${downloadHref}`) : null,
        voided: pass.status === 'voided',
        ...passDevice(c.req.header('user-agent')),
        support: await supportContacts(svcCtx, pass.orgId),
      });
      return new Response(html, { headers: PAGE_HEADERS });
    } catch (error) {
      if (error instanceof AppError && error.status === 404)
        return new Response(renderNotFoundPage(nonce), {
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
    if (response.status === 200)
      writeEvent(c.env, {
        event: 'pass.downloaded',
        orgId: pass.orgId,
        templateId: pass.templateId,
        identityId: pass.identityId,
      });
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
    };
    if (c.req.header('if-none-match') === asset.etag) {
      await asset.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    return new Response(asset.body, { headers });
  },
);
