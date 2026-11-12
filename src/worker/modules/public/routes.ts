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
import {
  PRESENTATION_HEADERS,
  renderPresentationNotFound,
  renderPresentationPage,
} from '../../ssr/presentation-page.tsx';
import { recordPassEvent } from '../events/record.ts';
import { servePassFile } from '../passes/file.ts';
import { type C, svc } from '../passes/http.ts';
import { listWalletOffers } from '../wallet-providers/offers.ts';
import { walletIssuanceByProvider } from '../wallet-providers/provider-policy.ts';
import { canPresent, presentationForPass } from './presentation.ts';
import {
  isTokenShape,
  openPublicAsset,
  pageModel,
  passForToken,
  supportContacts,
} from './service.ts';
import { assertPassSnapshot, capturePassSnapshot } from './snapshot.ts';

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
publicRoutes.use('/:token/barcode', rateLimit('RL_PUBLIC'));

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
      const snapshot = await capturePassSnapshot(svcCtx, pass);
      const model = await pageModel(svcCtx, pass);
      const page = `/p/${pass.downloadToken}`;
      // Resolve only links to this bearer under the same snapshot as the page and its assets.
      const walletOffers = canPresent(pass, model.passJson, svcCtx.clock.now())
        ? (await listWalletOffers(svcCtx, pass.id))
            .filter(({ provider, href }) => href === `${page}/wallet/${provider}`)
            .map(({ provider, href }) => ({ provider, href, installation: 'unknown' as const }))
        : [];
      const lang = langOf(c.req.header('accept-language'));
      const view = normalize(model.passJson, {
        assets: model.assets,
        locale: lang,
        now: new Date(svcCtx.clock.now()),
        timeZone: zoneOf(c) ?? 'UTC',
      });
      const html = renderPassPage({
        view,
        nonce,
        theme,
        orgName: view.organizationName || model.orgName,
        orgLabel: model.orgName,
        passTitle: pass.displayTitle ?? view.description ?? model.orgName,
        downloadHref: `${page}/pass.pkpass`,
        barcodeHref: `${page}/barcode`,
        walletOffers,
        issuance: walletIssuanceByProvider(),
        // The add QR opens this page on the phone, where the badge adds the pass.
        publicUrl: `${baseUrl(c.env)}${page}`,
        portalHref: `/passes/${pass.id}`,
        voided: pass.status === 'voided',
        removal: model.removal,
        mode: pass.mode,
        device: passDevice(c.req.header('user-agent')),
        support: await supportContacts(svcCtx, pass.orgId),
      });
      await assertPassSnapshot(svcCtx, snapshot);
      svcCtx.waitUntil(
        recordPassEvent(svcCtx, {
          orgId: pass.orgId,
          passId: pass.id,
          mode: pass.mode,
          kind: 'page.opened',
          actor: { type: 'holder', id: null },
        }),
      );
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
    path: '/{token}/barcode',
    summary: 'Present this pass barcode',
    params: PublicTokenParamSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const theme = requestTheme(c);
    try {
      const pass = await passForToken(ctx, c.req.valid('param').token);
      const snapshot = await capturePassSnapshot(ctx, pass);
      const model = await presentationForPass(ctx, pass);
      const html = renderPresentationPage({
        ...model,
        backHref: `/p/${pass.downloadToken}`,
        nonce: c.var.nonce,
        theme,
      });
      await assertPassSnapshot(ctx, snapshot);
      return new Response(html, { headers: PRESENTATION_HEADERS });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        return new Response(renderPresentationNotFound(c.var.nonce, theme), {
          status: 404,
          headers: PRESENTATION_HEADERS,
        });
      }
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
    const ctx = svc(c);
    const pass = await passForToken(ctx, c.req.valid('param').token);
    const snapshot = await capturePassSnapshot(ctx, pass);
    const response = await servePassFile(c.env.BUCKET, pass, c.req.raw);
    try {
      await assertPassSnapshot(ctx, snapshot);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
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
    try {
      await assertPassSnapshot(ctx, snapshot);
    } catch (error) {
      await response.body?.cancel();
      throw error;
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
    const snapshot = await capturePassSnapshot(ctx, pass);
    const asset = await openPublicAsset(ctx, pass, p.name);
    try {
      await assertPassSnapshot(ctx, snapshot);
    } catch (error) {
      await asset.body.cancel();
      throw error;
    }
    const headers = {
      'content-type': 'image/png',
      etag: asset.etag,
      'cache-control': 'private, no-store',
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
